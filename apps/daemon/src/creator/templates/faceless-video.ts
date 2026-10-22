import { z } from 'zod';
import type { CreatorTemplateDefinition } from './types.js';

const record = z.record(z.string(), z.unknown()) as never;

export function createFacelessVideoTemplate(): CreatorTemplateDefinition {
  return {
    id: 'faceless-video',
    version: 1,
    renderer: 'faceless-video',
    inputSchema: z.object({
      title: z.string().max(256).default('Untitled Faceless Documentary'),
      topic: z.string().default('Why Japan Has So Many Empty Houses'),
      script: z.string().default(''),
      audioFile: z.string().nullable().optional(),
      images: z.array(z.string()).default([]),
      targetDuration: z.number().positive().nullable().optional(),
      targetDurationMinutes: z.number().int().min(1).max(60).default(10),
      tone: z.enum(['documentary', 'investigative', 'storytelling', 'dramatic']).default('documentary'),
      scriptApproved: z.boolean().default(false),
      resolution: z.enum(['1080p', '720p']).default('1080p'),
      aspectRatio: z.enum(['16:9', '9:16']).default('16:9'),
      currentStep: z.number().int().min(0).max(10).default(0),
      furthestStep: z.number().int().min(0).max(10).default(0),
      currentStage: z.string().nullable().optional().default(null)
    }).passthrough() as never,
    stages: [
      {
        id: 'script',
        executor: 'faceless-video',
        allowedJobStatuses: ['draft', 'running', 'completed', 'failed', 'needs_input'],
        inputArtifacts: [],
        outputArtifacts: [
          { kind: 'faceless_script', status: 'completed' }
        ]
      },
      {
        id: 'timeline',
        executor: 'faceless-video',
        allowedJobStatuses: ['draft', 'running', 'completed', 'failed', 'needs_input'],
        inputArtifacts: [],
        outputArtifacts: [
          { kind: 'faceless_timeline', status: 'completed' },
          { kind: 'faceless_subtitles', status: 'completed' }
        ]
      },
      {
        id: 'render',
        executor: 'faceless-video',
        dependsOn: ['timeline'],
        allowedJobStatuses: ['draft', 'running', 'completed', 'failed', 'needs_input'],
        inputArtifacts: [
          { kind: 'faceless_timeline', selector: 'latest-completed' },
          { kind: 'faceless_subtitles', selector: 'latest-completed' }
        ],
        outputArtifacts: [
          { kind: 'faceless_video', status: 'completed' },
          { kind: 'faceless_metadata', status: 'completed' }
        ]
      }
    ],
    actions: [
      { id: 'update-settings', inputSchema: record, allowedStages: ['script', 'timeline', 'render'] },
      { id: 'run-stage', inputSchema: record, allowedStages: ['script', 'timeline', 'render'] },
      { id: 'retry-stage', inputSchema: record, allowedStages: ['script', 'timeline', 'render'] },
      { id: 'undo-action', inputSchema: record, allowedStages: ['script', 'timeline', 'render'] }
    ],
    outputs: [
      { kind: 'faceless_video', required: true }
    ],
    agentGuidance: [
      'Hỗ trợ người dùng sản xuất video YouTube faceless documentary 10-15 phút.',
      'Nhập chủ đề prompt -> AI sinh kịch bản chi tiết -> Người dùng duyệt kịch bản -> Sinh phân cảnh timeline -> Render MP4 1080p.'
    ].join(' ')
  };
}
