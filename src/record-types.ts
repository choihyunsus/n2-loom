// Parsed durable records carry bounded values before they can authorize another operation.
import type { JsonObject, ToolResult } from 'n2-hecaton';
import type { ModelReply } from 'n2-gumiho';
import type { CheckedRequest, DialogueProgress, LoomResult } from './run-types';

export interface RunRecord {
  request: CheckedRequest;
  config: JsonObject;
  state: 'running' | 'interrupted' | 'completed';
  revision: number;
  progress: DialogueProgress;
  verification: LoomResult['verification'];
  result: LoomResult | null;
  modelRequests: number;
  toolCalls: number;
  outputReserved: number;
  eventSequence: number;
  eventBytes: number;
  traceBytes: number;
  createdAt: number;
  updatedAt: number;
  error: string | null;
}
export interface ModelRecord {
  hash: string;
  state: 'pending' | 'completed';
  result: ModelReply | null;
  attempts: number;
}
export interface ToolRecord {
  requestId: string;
  input: JsonObject;
  hash: string;
  state: 'pending' | 'completed';
  result: ToolResult | null;
}
