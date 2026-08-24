import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { createApp } from '../server';
import { ConfigError } from '../project/config';
import type { Project } from '../project/config';
import { resolveProject, UsageError, VERSION } from '../cli';
import type { Args } from '../cli';

/**
 * Local by design.
 *
 * The server reads a repository's working files and applies no authentication,
 * so it binds the loopback interface. `--host` exists for people who know what
 * they are doing; the default never changes.
 */
export const DEFAULT_HOST = '127.0.0.1';

function port(args: Args, project: Project): number {
  const raw = args.flags.get('port');
  if (raw === undefined) return project.port;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new UsageError(`--port must be an integer between 1 and 65535, got "${String(raw)}"`);
  }
  return value;
}

/** Opens the user's browser, and never fails the command if it cannot. */
export function openBrowser(url: string): void {
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const argv = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(command, argv, { stdio: 'ignore', detached: true });
    child.on('error', () => {
      /* no browser here — the URL is printed above, which is enough */
    });
    child.unref();
  } catch {
    /* same */
  }
}

export interface StartedBrowser {
  server: Server;
  url: string;
}

/** Starts the HTTP server, turning a busy port into an explanation. */
export function listen(server: Server, portNumber: number, host: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.removeListener('listening', onListening);
      if (error.code === 'EADDRINUSE') {
        reject(
          new ConfigError(
            [
              `port ${portNumber} on ${host} is already in use.`,
              '',
              'Something is listening there — possibly another StoryMap.md.',
              'StoryMap.md will not attach to a process it did not start.',
              '',
              `Try:  storymap browser --port ${portNumber + 1}`,
            ].join('\n'),
          ),
        );
        return;
      }
      if (error.code === 'EACCES') {
        reject(new ConfigError(`port ${portNumber} needs privileges this process does not have.`));
        return;
      }
      reject(error);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolvePromise();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(portNumber, host);
  });
}

/** `storymap browser` — the local story-map browser. */
export async function runBrowser(args: Args, cwd: string): Promise<number> {
  const project = resolveProject(args, cwd);
  const chosenPort = port(args, project);
  const host = typeof args.flags.get('host') === 'string' ? String(args.flags.get('host')) : DEFAULT_HOST;
  const shouldOpen = args.flags.get('open') !== false;

  const { app, host: workspaceHost } = createApp(project);
  const ws = workspaceHost.get();
  const httpServer = createServer(app);
  await listen(httpServer, chosenPort, host);

  const url = `http://${host}:${chosenPort}`;
  process.stdout.write(
    [
      '',
      `  StoryMap.md ${VERSION}`,
      '',
      `  Project      ${project.projectName}`,
      `  Repository   ${project.root}`,
      `  Backlog      ${project.backlogDirectory}`,
      `  Maps         ${project.storyMapsDirectory}`,
      `  Stories      ${ws.index.size} (${ws.index.active.length} active, ${ws.index.completed.length} completed)`,
      `  Story maps   ${ws.maps.length}`,
      '',
      '  Listening on:',
      `  ${url}`,
      '',
      '  Files on disk are canonical; edits are picked up automatically.',
      '  Press Ctrl+C to stop.',
      '',
    ].join('\n'),
  );

  if (shouldOpen) openBrowser(url);

  await new Promise<void>((resolvePromise) => {
    const stop = () => {
      httpServer.close(() => resolvePromise());
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  return 0;
}
