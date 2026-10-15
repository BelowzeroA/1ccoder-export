// Every export in this file must be a plugin function (see agent-plugin.ts).
// Moves a prompt sent as `build` onto `plan` in `chat.message`, the way the
// 1CCoder desktop plugin moves one onto a session's bound agent.
export default async () => ({
  "chat.message": async (_input: unknown, output: { message: { agent: string } }) => {
    if (output.message.agent === "build") output.message.agent = "plan"
  },
})
