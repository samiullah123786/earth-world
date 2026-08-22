/**
 * One conversation, one card.
 *
 * The feed listed every speaker separately, so Sam and Zee talking to each
 * other appeared as two live chats about the same exchange, and a group of
 * four appeared as four. That is not a chat log, it is a list of mouths.
 *
 * A conversation is a set of people, not a person. This groups the Kernel's
 * pairwise `talkingWith` links into the actual conversations they describe -
 * two who found each other are one card, three or more in the same knot are
 * one group card, and somebody talking to a different partner about something
 * else is a card of their own.
 *
 * Pure and separate from the DOM so the grouping can be argued with in a test
 * rather than by squinting at a sidebar.
 */

export type Speaker = {
  agentId: string;
  name: string;
  family: string;
  talkingWith?: string | null;
  talkingUntil?: number | null;
  activity?: string;
};

export type Conversation = {
  /** Stable across polls: the members' ids, sorted and joined. */
  id: string;
  members: Speaker[];
  /** True once three or more people are in the same knot. */
  group: boolean;
  /** When the last member's turn runs out, for ordering by liveliness. */
  until: number;
};

/**
 * Group speakers into conversations by following who is talking to whom.
 *
 * Union-find, because a chain matters: if A is talking to B and B to C, all
 * three are in one conversation even though A never named C. Handling only
 * direct pairs would split a group of four into two couples that happen to
 * be standing together.
 */
export function groupConversations(speakers: Speaker[], now: number): Conversation[] {
  const live = speakers.filter((speaker) =>
    speaker.talkingWith && (speaker.talkingUntil ?? 0) > now);
  if (!live.length) return [];

  const byId = new Map(live.map((speaker) => [speaker.agentId, speaker]));
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    const seen = parent.get(id);
    if (!seen || seen === id) return id;
    const root = find(seen);
    parent.set(id, root);
    return root;
  };
  const union = (a: string, b: string) => {
    const rootA = find(a), rootB = find(b);
    if (rootA !== rootB) parent.set(rootA, rootB);
  };
  for (const speaker of live) parent.set(speaker.agentId, speaker.agentId);
  for (const speaker of live) {
    const partner = speaker.talkingWith!;
    // A partner who is not themselves talking is still part of this
    // conversation - one side falling quiet does not end it.
    if (!parent.has(partner)) parent.set(partner, partner);
    union(speaker.agentId, partner);
  }

  const knots = new Map<string, Set<string>>();
  for (const id of parent.keys()) {
    const root = find(id);
    if (!knots.has(root)) knots.set(root, new Set());
    knots.get(root)!.add(id);
  }

  const conversations: Conversation[] = [];
  for (const ids of knots.values()) {
    const members = [...ids]
      .map((id) => byId.get(id) ?? speakers.find((speaker) => speaker.agentId === id))
      .filter(Boolean) as Speaker[];
    if (members.length < 2) continue;
    members.sort((left, right) => left.name.localeCompare(right.name));
    conversations.push({
      id: members.map((member) => member.agentId).sort().join('+'),
      members,
      group: members.length >= 3,
      until: Math.max(...members.map((member) => member.talkingUntil ?? 0)),
    });
  }
  // Freshest first: a conversation with longer left to run is the one a
  // reader can still join.
  conversations.sort((left, right) => right.until - left.until);
  return conversations;
}

/** The one-line title a card carries before anyone opens it. */
export function conversationTitle(conversation: Conversation): string {
  const names = conversation.members.map((member) => member.name);
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]}`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} others`;
}

/** What the card says they are doing, without repeating the title. */
export function conversationSubtitle(conversation: Conversation): string {
  const activity = conversation.members
    .map((member) => member.activity)
    .find((line) => line && /talk|shar|greet|meet|discuss/i.test(line));
  if (activity) return activity.slice(0, 80);
  return conversation.group ? 'a group is talking' : 'talking';
}
