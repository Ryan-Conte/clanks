import { BrowserError } from '@clanks/browser';
import { ModelsError } from '@clanks/models';
import { ProviderError } from '@clanks/providers';
import { TRPCError } from '@trpc/server';
import { BoardError } from './board/service';
import { ChatError } from './chat/service';
import { ContextError } from './context/service';
import { CrewDocError } from './crew/docs';
import { DeliveryError } from './delivery/service';
import { GitHubError } from './github/service';
import { McpError } from './mcp/service';
import { ProjectError } from './projects/service';
import { SecretsUnavailableError } from './secrets';
import { publicProcedure } from './trpc';
import { WorkspaceError } from './workspace/service';

/** Errors meant for the user, such as a full drive or a rejected key, rather than bugs. */
export function isUserError(error: unknown): error is Error {
  return (
    error instanceof ModelsError ||
    error instanceof ProviderError ||
    error instanceof ChatError ||
    error instanceof CrewDocError ||
    error instanceof SecretsUnavailableError ||
    error instanceof WorkspaceError ||
    error instanceof McpError ||
    error instanceof BrowserError ||
    error instanceof ProjectError ||
    error instanceof BoardError ||
    error instanceof ContextError ||
    error instanceof DeliveryError ||
    error instanceof GitHubError
  );
}

/** A procedure whose user errors reach the window as they are, worded as they were. */
export const userProcedure = publicProcedure.use(async ({ next }) => {
  const result = await next();
  if (!result.ok && isUserError(result.error.cause)) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: result.error.cause.message,
      cause: result.error.cause,
    });
  }
  return result;
});
