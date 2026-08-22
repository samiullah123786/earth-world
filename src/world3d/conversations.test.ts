import { describe, expect, it } from 'vitest';
import { conversationTitle, groupConversations, type Speaker } from './conversations';

const NOW = 1_800_000_000_000;
const soon = NOW + 30_000;

const who = (name: string, talkingWith?: string, until = soon): Speaker => ({
  agentId: `agent:${name.toLowerCase()}`, name, family: 'engineering',
  talkingWith: talkingWith ? `agent:${talkingWith.toLowerCase()}` : null,
  talkingUntil: talkingWith ? until : null,
});

describe('grouping the town into conversations', () => {
  it('shows two people talking as ONE card, not two', () => {
    // The reported bug: Sam and Zee talking to each other filled the feed
    // with two live chats about the same exchange.
    const found = groupConversations([who('Sam', 'Zee'), who('Zee', 'Sam')], NOW);
    expect(found).toHaveLength(1);
    expect(found[0].members.map((m) => m.name)).toEqual(['Sam', 'Zee']);
    expect(found[0].group).toBe(false);
    expect(conversationTitle(found[0])).toBe('Sam and Zee');
  });

  it('follows a chain, so a group of three is one conversation', () => {
    // A talks to B, B talks to C. A never named C, but all three are in it -
    // handling only direct pairs would split this into two couples.
    const found = groupConversations([who('Ann', 'Bo'), who('Bo', 'Cy'), who('Cy', 'Bo')], NOW);
    expect(found).toHaveLength(1);
    expect(found[0].group).toBe(true);
    expect(found[0].members).toHaveLength(3);
  });

  it('keeps separate conversations separate', () => {
    const found = groupConversations([
      who('Sam', 'Zee'), who('Zee', 'Sam'),
      who('Ann', 'Bo'), who('Bo', 'Ann'),
    ], NOW);
    expect(found).toHaveLength(2);
    expect(found.every((conversation) => conversation.members.length === 2)).toBe(true);
  });

  it('includes a partner who has fallen quiet', () => {
    // One side going silent does not end a conversation, and dropping them
    // would leave a one-person "chat" that gets filtered away entirely.
    const found = groupConversations([who('Sam', 'Zee'), { ...who('Zee'), talkingWith: null }], NOW);
    expect(found).toHaveLength(1);
    expect(found[0].members.map((m) => m.name).sort()).toEqual(['Sam', 'Zee']);
  });

  it('ignores conversations whose time has run out', () => {
    const stale = groupConversations([
      who('Sam', 'Zee', NOW - 1000), who('Zee', 'Sam', NOW - 1000),
    ], NOW);
    expect(stale).toEqual([]);
  });

  it('gives a conversation a stable id across polls', () => {
    // The id keys the card in the DOM; if it changed between polls the panel
    // would tear itself down and rebuild every two seconds.
    const first = groupConversations([who('Sam', 'Zee'), who('Zee', 'Sam')], NOW);
    const second = groupConversations([who('Zee', 'Sam'), who('Sam', 'Zee')], NOW);
    expect(first[0].id).toBe(second[0].id);
  });

  it('puts the liveliest conversation first', () => {
    const found = groupConversations([
      who('Sam', 'Zee', NOW + 5_000), who('Zee', 'Sam', NOW + 5_000),
      who('Ann', 'Bo', NOW + 40_000), who('Bo', 'Ann', NOW + 40_000),
    ], NOW);
    expect(found[0].members[0].name).toBe('Ann');
  });

  it('names a large group without listing everyone', () => {
    const crowd = groupConversations([
      who('Ann', 'Bo'), who('Bo', 'Cy'), who('Cy', 'Dee'), who('Dee', 'Ann'),
    ], NOW);
    expect(crowd[0].members).toHaveLength(4);
    expect(conversationTitle(crowd[0])).toBe('Ann, Bo and 2 others');
  });

  it('says nothing when the town is quiet', () => {
    expect(groupConversations([who('Sam'), who('Zee')], NOW)).toEqual([]);
    expect(groupConversations([], NOW)).toEqual([]);
  });
});
