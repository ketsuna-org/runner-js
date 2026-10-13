import { expect, it } from 'bun:test';
import { ScriptExecutor } from '../src/scripts/script-executor.js';
it('a script can fetch an image and send it with AttachmentBuilder after deferReply', async () => {
  const ex = new ScriptExecutor(5000);
  const sent: unknown[] = [];
  const interaction = {
    deferReply: async () => {}, editReply: async (p: unknown) => { sent.push(p); },
    options: { getString: () => 'ceci' },
  };
  const logger = { info(){}, warn(){}, error(){}, debug(){}, child(){ return logger; } } as never;
  const r = await ex.execute(`
    const { AttachmentBuilder } = require('discord.js');
    await interaction.deferReply();
    const res = await fetch('data:text/plain;base64,eA=='); if (!res.ok) throw new Error('HTTP ' + res.status); const buf = Buffer.from(await res.arrayBuffer());
    const file = new AttachmentBuilder(buf, { name: 'image.png' });
    await interaction.editReply({ files: [file] });
    return file.name + buf.length;
  `, { client: {} as never, config: { token: 'x' } as never, variables: {}, interaction: interaction as never }, logger);
  expect(r).toBe('image.png1');
  expect(sent.length).toBe(1);
  ex.dispose();
});
