// ─────────────────────────────────────────────────────────────
//  mythos-router :: providers/tools.ts
//  Native tool-calling support for Strict Write Discipline.
//
//  The model emits file operations as a structured `write_files` tool call
//  instead of (or alongside) text FILE_ACTION blocks. The tool's argument shape
//  maps 1:1 onto actionsFromToolCalls(), so the SAME path-safety + verification
//  rules apply — the trust boundary is still the filesystem, only the transport
//  differs. This module is pure data + parsing so it is fully unit-testable
//  without a network round-trip.
// ─────────────────────────────────────────────────────────────

import { actionsFromToolCalls, type FileAction, type ToolCallFileAction } from '../swd.js';
import type { ToolDefinition, UnifiedToolCall } from './types.js';

export const FILE_ACTION_TOOL_NAME = 'write_files';

// The one tool Mythos exposes. Its schema mirrors a FILE_ACTION block.
export const FILE_ACTION_TOOL: ToolDefinition = {
  name: FILE_ACTION_TOOL_NAME,
  description:
    'Create, modify, or delete files to accomplish the task. Every file change MUST go through this tool. ' +
    'For CREATE/MODIFY provide the complete file content. For PATCH provide exact old/new spans (old must match once).',
  inputSchema: {
    type: 'object',
    properties: {
      actions: {
        type: 'array',
        description: 'One entry per file operation.',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Repository-relative path.' },
            operation: { type: 'string', enum: ['CREATE', 'MODIFY', 'DELETE', 'PATCH'] },
            intent: {
              type: 'string',
              enum: ['MUTATE', 'NOOP'],
              description: 'MUTATE if the file content should change; NOOP for a read-only touch.',
            },
            content: { type: 'string', description: 'Full file content for CREATE/MODIFY.' },
            old: { type: 'string', description: 'Exact text to find for PATCH (must appear once in the file).' },
            new: { type: 'string', description: 'Replacement text for PATCH.' },
            beforeHash: { type: 'string', description: 'Optional SHA-256 of the full file before PATCH.' },
            description: { type: 'string', description: 'One-line summary of the change.' },
          },
          required: ['path', 'operation', 'description'],
        },
      },
    },
    required: ['actions'],
  },
};

// ── Provider mappers ─────────────────────────────────────────
// Anthropic Messages API tool shape.
export function toAnthropicTool(tool: ToolDefinition): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  };
}

// OpenAI Chat Completions function-tool shape.
export function toOpenAITool(tool: ToolDefinition): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  };
}

// ── Response parsers (pure; fed real provider payload shapes) ─
type AnthropicContentBlock =
  | { type: 'text'; text?: string }
  | { type: 'thinking'; thinking?: string }
  | { type: 'tool_use'; id?: string; name?: string; input?: unknown }
  | { type: string; [k: string]: unknown };

function uniqueToolCallId(raw: unknown, prefix: string, index: number, used: Set<string>): string {
  const preferred = typeof raw === 'string' && raw.trim().length > 0
    ? raw
    : `${prefix}_${index + 1}`;
  if (!used.has(preferred)) {
    used.add(preferred);
    return preferred;
  }
  let suffix = 2;
  while (used.has(`${preferred}_${suffix}`)) suffix++;
  const unique = `${preferred}_${suffix}`;
  used.add(unique);
  return unique;
}

export function extractAnthropicToolCalls(content: readonly AnthropicContentBlock[] | undefined): UnifiedToolCall[] {
  if (!Array.isArray(content)) return [];
  const calls: UnifiedToolCall[] = [];
  const usedIds = new Set<string>();
  for (const block of content) {
    if (block && block.type === 'tool_use') {
      const b = block as { id?: string; name?: string; input?: unknown };
      if (typeof b.name !== 'string' || b.name.trim().length === 0) continue;
      calls.push({
        id: uniqueToolCallId(b.id, 'anthropic_tool', calls.length, usedIds),
        name: b.name,
        args: (b.input && typeof b.input === 'object' && !Array.isArray(b.input))
          ? (b.input as Record<string, unknown>)
          : {},
      });
    }
  }
  return calls;
}

interface OpenAIToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

export function extractOpenAIToolCalls(message: { tool_calls?: OpenAIToolCall[] } | undefined): UnifiedToolCall[] {
  const raw = message?.tool_calls;
  if (!Array.isArray(raw)) return [];
  const calls: UnifiedToolCall[] = [];
  const usedIds = new Set<string>();
  for (const call of raw) {
    if (typeof call?.function?.name !== 'string' || call.function.name.trim().length === 0) continue;
    let args: Record<string, unknown> = {};
    const argStr = call.function?.arguments;
    if (typeof argStr === 'string' && argStr.trim()) {
      try {
        const parsed = JSON.parse(argStr);
        if (parsed && typeof parsed === 'object') args = parsed as Record<string, unknown>;
      } catch {
        // Malformed tool arguments → treat as no actions; SWD never sees junk.
        args = {};
      }
    }
    calls.push({
      id: uniqueToolCallId(call.id, 'openai_tool', calls.length, usedIds),
      name: call.function.name,
      args,
    });
  }
  return calls;
}

// ── OpenAI streaming tool-call accumulation ──────────────────
// OpenAI streams tool calls as deltas keyed by `index`, with the function
// arguments arriving in fragments. This accumulator reassembles them; it is a
// pure object so the (otherwise untestable) streaming path's logic can be
// unit-tested against fixture delta sequences.
export interface OpenAIToolCallDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

export class OpenAIToolCallAccumulator {
  private byIndex = new Map<number, { id: string; name: string; args: string }>();

  add(deltas: OpenAIToolCallDelta[] | undefined): void {
    if (!Array.isArray(deltas)) return;
    for (const d of deltas) {
      const idx = typeof d.index === 'number' ? d.index : 0;
      const cur = this.byIndex.get(idx) ?? { id: '', name: '', args: '' };
      if (d.id) cur.id = d.id;
      if (d.function?.name) cur.name = d.function.name;
      if (typeof d.function?.arguments === 'string') cur.args += d.function.arguments;
      this.byIndex.set(idx, cur);
    }
  }

  hasAny(): boolean {
    return this.byIndex.size > 0;
  }

  finalize(): UnifiedToolCall[] {
    const out: UnifiedToolCall[] = [];
    const usedIds = new Set<string>();
    for (const [index, v] of [...this.byIndex.entries()].sort((a, b) => a[0] - b[0])) {
      if (!v.name) continue;
      let args: Record<string, unknown> = {};
      if (v.args.trim()) {
        try {
          const parsed = JSON.parse(v.args);
          if (parsed && typeof parsed === 'object') args = parsed as Record<string, unknown>;
        } catch {
          args = {};
        }
      }
      out.push({ id: uniqueToolCallId(v.id, 'openai_stream_tool', index, usedIds), name: v.name, args });
    }
    return out;
  }
}

// ── Tool-choice mapper for OpenAI ────────────────────────────
export function toOpenAIToolChoice(tc: 'auto' | 'required' | { name: string } | undefined): unknown {
  if (tc === 'required') return 'required';
  if (tc === 'auto') return 'auto';
  if (tc && typeof tc === 'object') return { type: 'function', function: { name: tc.name } };
  return undefined;
}

// Pulls the `actions` array out of any write_files tool call and runs it
// through the same validator as the text parser. Unknown tools are ignored.
export function toolCallsToActions(toolCalls: readonly UnifiedToolCall[] | undefined): FileAction[] {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return [];
  const raw: ToolCallFileAction[] = [];
  for (const call of toolCalls) {
    if (call.name !== FILE_ACTION_TOOL_NAME) continue;
    const actions = (call.args as { actions?: unknown }).actions;
    if (Array.isArray(actions)) {
      raw.push(...(actions as ToolCallFileAction[]));
    }
  }
  return actionsFromToolCalls(raw);
}
