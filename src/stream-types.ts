// Streaming providers retain the published normalized model contract and deliver only visible text.
import type { ModelProvider, ModelReply, ModelRequest } from 'n2-gumiho';
import type { JsonObject } from 'n2-hecaton';
export type TextSink = (delta: string) => void | Promise<void>;
export interface StreamingProvider extends ModelProvider {
  readonly textStreaming: boolean;
  stream(request: ModelRequest, onText: TextSink): Promise<ModelReply>;
}
export interface StreamStep {
  delta?: string;
  completed?: JsonObject;
}
export interface StreamDecoder {
  accept(event: JsonObject): StreamStep;
}
