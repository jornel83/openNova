/** Accept only the current turn's successfully committed, uninterrupted assistant text. */
export function completedReply(result) {
  const terminal = result.events.findLast(event => event.type === 'turn/end');
  const assistant = result.events.findLast(event => event.type === 'assistant/message');
  const text = assistant?.data?.message?.content
    ?.filter(block => block.type === 'text').map(block => block.text).join('');
  if (terminal?.data?.reason?.kind !== 'completed' || !assistant?.data ||
      assistant.data.interrupted || assistant.data.turn !== terminal.data.turn ||
      !text?.trim() || text !== result.finalResponse) throw new Error('incomplete_agent_turn');
  return text;
}
