// Use the pinned bounded stdio transport and close active provider/MCP work when its input ends.
import { ServerStdioTransport } from 'n2-hecaton/dist/mcp-server-transport';
import { createMcpServer } from './mcp';
import { reportFailure, outputStream } from './output';
import type { Loom } from './loom';
export async function serve(engine: Loom, signal: AbortSignal): Promise<void> {
  const server = createMcpServer(engine);
  const stop = () => {
    void server.close().catch(reportFailure);
  };
  const stopped = new Promise<void>((resolve) => {
    server.server.onclose = () => {
      signal.removeEventListener('abort', stop);
      void engine.close().catch(reportFailure).finally(resolve);
    };
  });
  server.server.onerror = reportFailure;
  signal.addEventListener('abort', stop, { once: true });
  try {
    signal.throwIfAborted();
    await server.connect(new ServerStdioTransport(process.stdin, outputStream));
    await stopped;
  } finally {
    signal.removeEventListener('abort', stop);
    await server.close();
  }
}
