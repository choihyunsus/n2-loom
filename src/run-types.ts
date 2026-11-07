// A dialogue owns durable model turns, tool receipts and one conversation revision in an explicit scope.
import type { HecatonOptions, JsonObject, ToolView, ToolResult, McpServer } from 'n2-hecaton';
import type { ModelMessage, ModelProvider, ModelReply } from 'n2-gumiho';
import type { RunReceipt } from 'n2-recipe';
import type { StreamingProvider } from './stream-types';
import type { LoomLimits } from './limits';

export interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}
export interface LoomRequest {
  runId: string;
  conversationId: string;
  message: string;
  mode?: 'chat' | 'agent';
  providerId?: string;
  system?: string;
  history?: HistoryMessage[];
}
export interface CheckedRequest extends Required<Omit<LoomRequest, 'history'>> {
  history: HistoryMessage[];
}
export interface DialogueContext {
  readonly project: string;
  readonly agent: string;
  readonly runId: string;
  readonly conversationId: string;
  readonly message: string;
  readonly signal: AbortSignal;
}
export interface DialogueVerification {
  success: boolean;
  summary: string;
  evidence?: JsonObject;
}
export interface DialogueVerifier {
  version: string;
  verify(
    context: DialogueContext & {
      readonly output: string;
      readonly modifiedFiles: readonly string[];
      readonly failures: number;
      readonly toolRequestIds: readonly string[];
    },
  ): DialogueVerification | Promise<DialogueVerification>;
}
export interface DialoguePreparation {
  version: string;
  prepare(context: DialogueContext): ToolResult | Promise<ToolResult>;
}
export interface ConfirmationRequest extends DialogueContext {
  readonly id: string;
  readonly toolRequestId: string;
  readonly tool: ToolView;
  readonly arguments: JsonObject;
  readonly expiresAt: number;
}
export interface DialogueConfirmation {
  version: string;
  request(context: ConfirmationRequest): boolean | Promise<boolean>;
}
export interface LoomOptions {
  dbPath: string;
  project: string;
  agent: string;
  provider: ModelProvider | StreamingProvider;
  providers?: Array<ModelProvider | StreamingProvider>;
  tools?: HecatonOptions['tools'];
  mcpServers?: McpServer[];
  policy?: HecatonOptions['policy'];
  preparation?: DialoguePreparation;
  verifier?: DialogueVerifier;
  confirmation?: DialogueConfirmation;
  limits?: Partial<LoomLimits>;
}
export type EventKind =
  | 'started'
  | 'delta'
  | 'tool_call'
  | 'tool_confirm'
  | 'tool_start'
  | 'tool_result'
  | 'handoff'
  | 'verified'
  | 'done'
  | 'error'
  | 'cancelled';
export interface LoomEvent {
  runId: string;
  conversationId: string;
  sequence: number;
  type: EventKind;
  data: JsonObject;
  createdAt: number;
}
export interface LoomObserver {
  signal?: AbortSignal;
  afterSequence?: number;
  onEvent?(event: LoomEvent & { replay: boolean }): void | Promise<void>;
}
export interface LoomResult {
  runId: string;
  conversationId: string;
  success: boolean;
  error: string | null;
  output: string;
  modifiedFiles: string[];
  verification: (DialogueVerification & { kind: 'protocol' | 'host' }) | null;
  lifecycle: RunReceipt;
  experienceId: string;
  checkpointId: string | null;
  cached: boolean;
  budget: {
    modelRequests: number;
    toolCalls: number;
    outputTokensReserved: number;
    generations: number;
    failures: number;
  };
}
export interface DialogueProgress {
  phase: 'model' | 'tools' | 'finished';
  turn: number;
  generation: number;
  messages: ModelMessage[];
  nextTool: number;
  lastReply: ModelReply | null;
  output: string;
  modifiedFiles: string[];
  toolRequestIds: string[];
  failures: number;
  lastSignature: string | null;
  selectedTools: string[];
  success: boolean;
  error: string | null;
}
