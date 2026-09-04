import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Journal character-page rewrite feedback', () => {
  it('silently saves the draft and reports the real rewrite operation globally', () => {
    const source = readFileSync(path.resolve(__dirname, '../apps/JournalApp.tsx'), 'utf8');
    const exchangeStart = source.indexOf('const handleExchange = async () =>');
    const archiveStart = source.indexOf('const handleArchiveDiary = async', exchangeStart);
    const exchangeSource = source.slice(exchangeStart, archiveStart);

    expect(source).toContain("const saveEntry = async (options: { silent?: boolean } = {})");
    expect(source).toContain("if (!options.silent) addToast('Diary saved', 'success')");
    expect(exchangeSource).toContain('await saveEntry({ silent: true })');
    expect(exchangeSource).not.toContain('saveEntry();');
    expect(exchangeSource).toContain('Asking ${selectedChar.name} to rewrite this diary');
    expect(exchangeSource).toContain('Character diary rewritten · synced to chat');
    expect(exchangeSource).toContain("'Rewrite diary' : 'Exchange diary'");
    expect(source).toContain('data-testid="journal-rewrite-character-page"');
    expect(source).toContain('aria-label="Rewrite character\'s diary"');
  });
});
