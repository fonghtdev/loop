import { ApiError } from "./auth-client";
import { findThread, session, threadChanged, threadPanel } from "./app";
import type { Thread } from "./threads";

const request = session.client.request;

/** The server's answer is applied at once (the `thread:*` echo then changes nothing). */
const applied = (thread: Thread) => {
  threadChanged({ type: "thread:updated", thread });
  return thread;
};

/**
 * Starts a thread from `messageId` and opens it beside the channel. Someone else may have been faster (409): then
 * theirs opens. Throws the ApiError otherwise (the dialog shows it).
 */
export async function startThread(channelId: string, messageId: string, name: string) {
  try {
    const thread = await request<Thread>("POST", `/channels/${channelId}/messages/${messageId}/thread`, { name });
    threadChanged({ type: "thread:created", thread });
    threadPanel.open(thread);
  } catch (e) {
    const existing = e instanceof ApiError && e.status === 409 ? await findThread(channelId, (t) => t.starterMessageId === messageId) : undefined;
    if (!existing) throw e;
    threadChanged({ type: "thread:updated", thread: existing });
    threadPanel.open(existing);
  }
}

export const renameThread = async (id: string, name: string) => applied(await request<Thread>("PATCH", `/threads/${id}`, { name }));
export const setArchived = async (id: string, archived: boolean) => applied(await request<Thread>("PATCH", `/threads/${id}`, { archived }));

/** Deletes it; the panel closes first so no "was deleted" notice is shown for our own act. */
export async function deleteThread(thread: Thread) {
  await request("DELETE", `/threads/${thread.id}`);
  threadPanel.close();
  threadChanged({ type: "thread:deleted", gone: { id: thread.id, guildId: thread.guildId, parentChannelId: thread.parentChannelId, starterMessageId: thread.starterMessageId } });
}
