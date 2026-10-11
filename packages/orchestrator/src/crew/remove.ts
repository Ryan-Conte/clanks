import type { ChatService } from '../chat/service';
import type { ProjectService } from '../projects/service';
import type { CrewService } from './crew';
import { CrewDocError } from './docs';

/**
 * Takes a custom clank out of the library, with its chats. It must be out of every project's crew
 * first, so no ticket is left waiting on a clank that's gone.
 */
export async function removeCustomClank(
  deps: { crew: CrewService; projects: ProjectService; chat: ChatService },
  id: string,
): Promise<void> {
  const clank = deps.crew.get(id);
  if (!clank.custom) {
    throw new CrewDocError(`${clank.name} ships with the app, so it can't be deleted.`);
  }
  const using = deps.projects.using(id);
  if (using.length > 0) {
    throw new CrewDocError(
      `${clank.name} is in the crew of ${using.map((p) => p.name).join(', ')}. Take it out there first, in the project's settings.`,
    );
  }
  for (const conversation of deps.chat.list().filter((c) => c.clankId === id)) {
    await deps.chat.delete(conversation.id);
  }
  deps.crew.deleteCustom(id);
}
