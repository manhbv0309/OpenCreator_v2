import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from '@iarna/toml';
import {
  createCodexAppServerHost,
  type CodexAppServerHost,
  type CodexAppServerHostInput
} from '../../codex/app-server-host-2026-07-28.js';

export const KRILLIN_LLM_ROUTE_PREFIX = '/internal/krillin-llm';

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };
type HostSlot = { host?: CodexAppServerHost; busy: boolean; configurationVersion?: string };

const HOST_POOL_SIZE = 2;
const MAX_QUEUED_REQUESTS = 32;
const SSE_HEARTBEAT_MS = 10_000;

export function createKrillinCodexLlmGateway(input: {
  codexBin: string;
  codexHome: string;
  cwd: string;
  createHost?: typeof createCodexAppServerHost;
  readConfiguration?(): { codexHome: string; version: string };
}) {
  const token = `ocllm_${randomBytes(32).toString('base64url')}`;
  const slots: HostSlot[] = Array.from({ length: HOST_POOL_SIZE }, () => ({ busy: false }));
  const waiters: Array<{
    resolve(slot: HostSlot): void;
    reject(error: Error): void;
  }> = [];
  let closing = false;

  return {
    config(baseUrl: string) {
      return {
        baseUrl: `${baseUrl}${KRILLIN_LLM_ROUTE_PREFIX}/v1`,
        apiKey: token,
        model: 'codex'
      };
    },
    async register(server: FastifyInstance): Promise<void> {
      server.post(`${KRILLIN_LLM_ROUTE_PREFIX}/v1/chat/completions`, async (request, reply) => {
        if (!authorized(request, token)) {
          return reply.code(401).send({ error: { message: 'Invalid Krillin LLM token' } });
        }
        const body = readBody(request.body, reply);
        if (body === undefined) return;
        const messages = readMessages(body.messages, reply);
        if (messages === undefined) return;
        const completionId = `chatcmpl-${randomBytes(12).toString('hex')}`;
        const stream = body.stream === true;
        if (stream) {
          reply.hijack();
          reply.raw.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache, no-transform',
            connection: 'keep-alive',
            'x-accel-buffering': 'no'
          });
          reply.raw.write(': connected\n\n');
          const heartbeat = setInterval(() => reply.raw.write(': keep-alive\n\n'), SSE_HEARTBEAT_MS);
          heartbeat.unref();
          try {
            const content = await runCompletion(messages, readJsonMode(body.response_format));
            writeSseCompletion(reply, completionId, content);
          } catch (error) {
            reply.raw.destroy(toError(error));
          } finally {
            clearInterval(heartbeat);
          }
          return;
        }
        try {
          const content = await runCompletion(messages, readJsonMode(body.response_format));
          return chatCompletion(completionId, content);
        } catch (error) {
          return reply.code(502).send({
            error: {
              message: toError(error).message,
              type: 'upstream_error',
              code: 'codex_completion_failed'
            }
          });
        }
      });
    },
    async close(): Promise<void> {
      closing = true;
      for (const waiter of waiters.splice(0)) {
        waiter.reject(new Error('Krillin Codex LLM gateway is closing'));
      }
      await Promise.all(slots.map(async slot => {
        await slot.host?.close('krillin-llm-gateway-closed').catch(() => undefined);
        slot.host = undefined;
      }));
    }
  };

  async function runCompletion(messages: ChatMessage[], jsonMode: boolean): Promise<string> {
    const slot = await acquireSlot();
    try {
      const configuration = input.readConfiguration?.();
      if (slot.host === undefined || !slot.host.isReusable()
        || slot.configurationVersion !== configuration?.version) {
        await slot.host?.close('krillin-llm-host-replaced').catch(() => undefined);
        slot.host = (input.createHost ?? createCodexAppServerHost)({
          codexBin: input.codexBin,
          codexHome: configuration?.codexHome ?? input.codexHome,
          cwd: resolve(input.cwd),
          profile: 'default',
          builtInTools: {
            shell: false,
            fileRead: false,
            fileWrite: false,
            applyPatch: false,
            webSearch: false
          }
        });
        await slot.host.started;
        slot.configurationVersion = configuration?.version;
      }
      return await complete({
        host: slot.host,
        codexHome: configuration?.codexHome ?? input.codexHome,
        cwd: input.cwd,
        messages,
        jsonMode
      });
    } catch (error) {
      if (slot.host?.isReusable() !== true) {
        await slot.host?.close('krillin-llm-host-failed').catch(() => undefined);
        slot.host = undefined;
      }
      throw error;
    } finally {
      releaseSlot(slot);
    }
  }

  function acquireSlot(): Promise<HostSlot> {
    if (closing) return Promise.reject(new Error('Krillin Codex LLM gateway is closing'));
    const slot = slots.find(candidate => !candidate.busy);
    if (slot !== undefined) {
      slot.busy = true;
      return Promise.resolve(slot);
    }
    if (waiters.length >= MAX_QUEUED_REQUESTS) {
      return Promise.reject(new Error('Krillin Codex LLM request queue is full'));
    }
    return new Promise((resolveWaiter, reject) => {
      waiters.push({ resolve: resolveWaiter, reject });
    });
  }

  function releaseSlot(slot: HostSlot): void {
    const waiter = waiters.shift();
    if (waiter !== undefined && !closing) {
      waiter.resolve(slot);
      return;
    }
    slot.busy = false;
  }
}

async function complete(input: {
  host: CodexAppServerHost;
  codexHome: string;
  cwd: string;
  messages: ChatMessage[];
  jsonMode: boolean;
}): Promise<string> {
  const messages = new Map<string, string>();
  let failureMessage: string | undefined;
  const process = input.host.run({
    cwd: resolve(input.cwd),
    sandbox: 'read-only',
    model: resolveAvailableChatGptModel(input.codexHome),
    prompt: conversationPrompt(input.messages),
    developerInstructions: input.jsonMode
      ? 'Return exactly one valid JSON value. Do not use Markdown fences or commentary. Do not call tools.'
      : 'Answer the conversation directly. Do not call tools.',
    timeoutMs: 2 * 60_000,
    inactivityTimeoutMs: 90_000,
    onNotification(notification) {
      recordAgentMessage(messages, notification);
      failureMessage = readTurnFailureMessage(notification) ?? failureMessage;
    }
  });
  const result = await process.result;
  const content = [...messages.values()].at(-1)?.trim() ?? '';
  if (result.turnStatus !== 'completed') {
    throw new Error([
      `Codex LLM completion ended with status ${result.turnStatus}`,
      failureMessage
    ].filter(Boolean).join(': '));
  }
  if (content === '') throw new Error('Codex LLM completion returned an empty response');
  return content;
}

function resolveAvailableChatGptModel(codexHome: string): string | undefined {
  try {
    const auth = JSON.parse(readFileSync(resolve(codexHome, 'auth.json'), 'utf8')) as unknown;
    const authRecord = record(auth);
    const tokens = record(authRecord?.tokens);
    if (authRecord?.auth_mode === 'apikey'
      || (authRecord?.auth_mode !== 'chatgpt' && typeof tokens?.access_token !== 'string')) {
      return undefined;
    }
    const config = parse(readFileSync(resolve(codexHome, 'config.toml'), 'utf8'));
    const configured = typeof config.model === 'string' ? config.model.trim() : '';
    const catalog = record(JSON.parse(readFileSync(resolve(codexHome, 'models_cache.json'), 'utf8')));
    const models = Array.isArray(catalog?.models) ? catalog.models.flatMap(candidate => {
      const model = record(candidate);
      return typeof model?.slug === 'string' && model.supported_in_api === true
        ? [{
            slug: model.slug,
            visibility: model.visibility,
            priority: typeof model.priority === 'number' ? model.priority : Number.MAX_SAFE_INTEGER
          }]
        : [];
    }) : [];
    if (models.some(model => model.slug === configured)) return configured;
    return models
      .filter(model => model.visibility === 'list')
      .sort((left, right) => left.priority - right.priority)[0]?.slug;
  } catch {
    return undefined;
  }
}

function readTurnFailureMessage(notification: Record<string, unknown>): string | undefined {
  if (notification.method !== 'turn/completed') return undefined;
  const turn = record(record(notification.params)?.turn);
  const error = record(turn?.error);
  const message = typeof error?.message === 'string' ? error.message.trim() : '';
  const details = typeof error?.additionalDetails === 'string'
    ? error.additionalDetails.trim()
    : '';
  return [message, details].filter(Boolean).join(' — ') || undefined;
}

function chatCompletion(id: string, content: string) {
  return {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'codex',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  };
}

function writeSseCompletion(reply: FastifyReply, id: string, content: string): void {
  const created = Math.floor(Date.now() / 1000);
  const chunk = (delta: Record<string, string>, finishReason: string | null) => ({
    id,
    object: 'chat.completion.chunk',
    created,
    model: 'codex',
    choices: [{ index: 0, delta, finish_reason: finishReason }]
  });
  writeSse(reply, chunk({ role: 'assistant' }, null));
  writeSse(reply, chunk({ content }, null));
  writeSse(reply, chunk({}, 'stop'));
  reply.raw.end('data: [DONE]\n\n');
}

function writeSse(reply: FastifyReply, value: unknown): void {
  reply.raw.write(`data: ${JSON.stringify(value)}\n\n`);
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function conversationPrompt(messages: ChatMessage[]): string {
  return messages.map(message => `${message.role.toUpperCase()}:\n${message.content}`).join('\n\n');
}

function recordAgentMessage(messages: Map<string, string>, notification: Record<string, unknown>): void {
  const params = record(notification.params);
  const item = record(params?.item);
  const id = typeof params?.itemId === 'string'
    ? params.itemId
    : typeof item?.id === 'string' ? item.id : undefined;
  if (id === undefined) return;
  if (item?.type === 'agentMessage' && typeof item.text === 'string') {
    messages.set(id, item.text);
  } else if (notification.method === 'item/agentMessage/delta' && typeof params?.delta === 'string') {
    messages.set(id, (messages.get(id) ?? '') + params.delta);
  }
}

function authorized(request: FastifyRequest, token: string): boolean {
  const value = request.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '';
  const left = Buffer.from(value);
  const right = Buffer.from(token);
  return left.length === right.length && timingSafeEqual(left, right);
}

function readBody(value: unknown, reply: FastifyReply): Record<string, unknown> | undefined {
  const body = record(value);
  if (body !== undefined) return body;
  void reply.code(400).send({ error: { message: 'Request body must be an object' } });
  return undefined;
}

function readMessages(value: unknown, reply: FastifyReply): ChatMessage[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    void reply.code(400).send({ error: { message: 'messages must be a non-empty array' } });
    return undefined;
  }
  const messages = value.flatMap(candidate => {
    const message = record(candidate);
    return (message?.role === 'system' || message?.role === 'user' || message?.role === 'assistant')
      && typeof message.content === 'string'
      ? [{ role: message.role, content: message.content } satisfies ChatMessage]
      : [];
  });
  if (messages.length !== value.length) {
    void reply.code(400).send({ error: { message: 'messages contain an unsupported value' } });
    return undefined;
  }
  return messages;
}

function readJsonMode(value: unknown): boolean {
  return record(value)?.type === 'json_object';
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
