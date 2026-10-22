import Fastify from 'fastify';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createKrillinCodexLlmGateway } from '../../src/creator/krillin/codex-llm-gateway.js';

describe('Krillin Codex LLM gateway', () => {
  let root = '';

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = '';
  });

  it('authenticates and converts a Codex final message to chat completions', async () => {
    const run = vi.fn((input: { onNotification?(value: Record<string, unknown>): void }) => {
      input.onNotification?.({
        method: 'item/completed',
        params: { item: { id: 'answer', type: 'agentMessage', text: '{"translation":"你好"}' } }
      });
      return {
        cancel() {},
        result: Promise.resolve({
          threadId: 'thread-1',
          turnId: 'turn-1',
          turnStatus: 'completed' as const,
          stderr: '',
          terminationReason: 'completed' as const,
          outputTruncation: {
            stderr: { truncated: false, droppedBytes: 0, droppedItems: 0 },
            frames: { truncated: false, droppedBytes: 0, droppedItems: 0 }
          }
        })
      };
    });
    const createHost = vi.fn(() => ({
      pid: 1,
      started: Promise.resolve(1),
      run,
      isReusable: () => true,
      close: vi.fn(async () => undefined)
    }));
    let configurationVersion = 'first';
    const gateway = createKrillinCodexLlmGateway({
      codexBin: '/bundled/codex',
      codexHome: '/isolated/codex-home',
      cwd: '/workspace',
      createHost,
      readConfiguration: () => ({ codexHome: '/following/local-home', version: configurationVersion })
    });
    const server = Fastify();
    await gateway.register(server);
    const config = gateway.config('http://127.0.0.1:1234');

    const unauthorized = await server.inject({
      method: 'POST',
      url: '/internal/krillin-llm/v1/chat/completions',
      payload: { messages: [{ role: 'user', content: 'translate' }] }
    });
    expect(unauthorized.statusCode).toBe(401);

    const response = await server.inject({
      method: 'POST',
      url: '/internal/krillin-llm/v1/chat/completions',
      headers: { authorization: `Bearer ${config.apiKey}` },
      payload: {
        model: 'codex',
        messages: [
          { role: 'system', content: 'Translate subtitles.' },
          { role: 'user', content: 'Hello' }
        ],
        response_format: { type: 'json_object' }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      model: 'codex',
      choices: [{ message: { role: 'assistant', content: '{"translation":"你好"}' } }]
    });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining('SYSTEM:\nTranslate subtitles.'),
      developerInstructions: expect.stringContaining('valid JSON')
    }));
    const origin = await server.listen({ port: 0, host: '127.0.0.1' });
    const streamed = await fetch(`${origin}/internal/krillin-llm/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'codex',
        stream: true,
        messages: [{ role: 'user', content: 'Hello' }]
      })
    });
    const streamBody = await streamed.text();
    expect(streamed.status).toBe(200);
    expect(streamed.headers.get('content-type')).toContain('text/event-stream');
    expect(streamBody).toContain('"object":"chat.completion.chunk"');
    expect(streamBody).toContain('"content":"{\\"translation\\":\\"你好\\"}"');
    expect(streamBody).toContain('data: [DONE]');
    expect(createHost).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(2);
    expect(createHost).toHaveBeenCalledWith(expect.objectContaining({ codexHome: '/following/local-home' }));
    configurationVersion = 'changed';
    expect((await server.inject({ method: 'POST', url: '/internal/krillin-llm/v1/chat/completions',
      headers: { authorization: `Bearer ${config.apiKey}` },
      payload: { messages: [{ role: 'user', content: 'New configuration' }] }
    })).statusCode).toBe(200);
    expect(createHost).toHaveBeenCalledTimes(2);
    expect(createHost.mock.results[0]!.value.close).toHaveBeenCalledOnce();
    await gateway.close();
    await server.close();
  });

  it('uses the first available ChatGPT model when the configured model is stale', async () => {
    root = await mkdtemp(join(tmpdir(), 'krillin-codex-model-'));
    await writeFile(join(root, 'auth.json'), JSON.stringify({
      auth_mode: 'chatgpt', tokens: { access_token: 'oauth-secret' }
    }));
    await writeFile(join(root, 'config.toml'), 'model = "stale-model"\n');
    await writeFile(join(root, 'models_cache.json'), JSON.stringify({
      models: [
        { slug: 'hidden-model', visibility: 'hide', supported_in_api: true, priority: 1 },
        { slug: 'fallback-model', visibility: 'list', supported_in_api: true, priority: 2 },
        { slug: 'later-model', visibility: 'list', supported_in_api: true, priority: 9 }
      ]
    }));
    const run = vi.fn((input: { onNotification?(value: Record<string, unknown>): void }) => {
      input.onNotification?.({
        method: 'item/completed',
        params: { item: { id: 'answer', type: 'agentMessage', text: 'translated' } }
      });
      return { cancel() {}, result: Promise.resolve(completedResult()) };
    });
    const gateway = createKrillinCodexLlmGateway({
      codexBin: '/bundled/codex', codexHome: root, cwd: root,
      createHost: vi.fn(() => fakeHost(run))
    });
    const server = Fastify();
    await gateway.register(server);
    const config = gateway.config('http://127.0.0.1:1234');

    const response = await server.inject({
      method: 'POST',
      url: '/internal/krillin-llm/v1/chat/completions',
      headers: { authorization: `Bearer ${config.apiKey}` },
      payload: { messages: [{ role: 'user', content: 'Translate' }] }
    });

    expect(response.statusCode).toBe(200);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ model: 'fallback-model' }));
    await gateway.close();
    await server.close();
  });

  it('returns the underlying Codex turn error when completion fails', async () => {
    const run = vi.fn((input: { onNotification?(value: Record<string, unknown>): void }) => {
      input.onNotification?.({
        method: 'turn/completed',
        params: { turn: { error: { message: 'Selected model is unavailable', additionalDetails: null } } }
      });
      return { cancel() {}, result: Promise.resolve({ ...completedResult(), turnStatus: 'failed' as const }) };
    });
    const gateway = createKrillinCodexLlmGateway({
      codexBin: '/bundled/codex', codexHome: '/missing/codex-home', cwd: '/workspace',
      createHost: vi.fn(() => fakeHost(run))
    });
    const server = Fastify();
    await gateway.register(server);
    const config = gateway.config('http://127.0.0.1:1234');

    const response = await server.inject({
      method: 'POST',
      url: '/internal/krillin-llm/v1/chat/completions',
      headers: { authorization: `Bearer ${config.apiKey}` },
      payload: { messages: [{ role: 'user', content: 'Translate' }] }
    });

    expect(response.statusCode).toBe(502);
    expect(response.json().error.message).toContain('Selected model is unavailable');
    await gateway.close();
    await server.close();
  });
});

function completedResult() {
  return {
    threadId: 'thread-1', turnId: 'turn-1', turnStatus: 'completed' as const,
    stderr: '', terminationReason: 'completed' as const,
    outputTruncation: {
      stderr: { truncated: false, droppedBytes: 0, droppedItems: 0 },
      frames: { truncated: false, droppedBytes: 0, droppedItems: 0 }
    }
  };
}

function fakeHost(run: ReturnType<typeof vi.fn>) {
  return {
    pid: 1,
    started: Promise.resolve(1),
    run,
    isReusable: () => true,
    close: vi.fn(async () => undefined)
  };
}
