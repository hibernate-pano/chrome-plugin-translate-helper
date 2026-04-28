import type { BridgeHealth } from '@translate-helper/shared-protocol';

import { fetchBridgeHealth } from './bridge-client';
import { type BridgeSettings } from './messages';
import {
  getSettings,
  getTermTable,
  saveSettings,
  saveTermTable,
  type TermEntry,
  type TermTable
} from './settings';

function assertElement<T extends Element>(
  id: string,
  selector: string
): T {
  const el = document.querySelector(selector) as T | null;
  if (!el) {
    throw new Error(`options.ts: required element "${id}" not found (${selector})`);
  }
  return el;
}

const form = assertElement<HTMLFormElement>('options-form', '#options-form');
const bridgeUrlInput = assertElement<HTMLInputElement>('bridge-url', '#bridge-url');
const pairingTokenInput = assertElement<HTMLInputElement>('pairing-token', '#pairing-token');
const targetLanguageInput = assertElement<HTMLInputElement>('target-language', '#target-language');
const translatedFontFamilyInput = assertElement<HTMLSelectElement>('translated-font-family', '#translated-font-family');
const translatedTextColorInput = assertElement<HTMLInputElement>('translated-text-color', '#translated-text-color');
const toggleTokenVisibilityButton = assertElement<HTMLButtonElement>('toggle-token-visibility', '#toggle-token-visibility');
const testBridgeButton = assertElement<HTMLButtonElement>('test-bridge', '#test-bridge');
const preview = assertElement<HTMLDivElement>('translated-preview', '#translated-preview');
const saveStatus = assertElement<HTMLSpanElement>('save-status', '#save-status');
const bridgeCheckStatus = assertElement<HTMLDivElement>('bridge-check-status', '#bridge-check-status');
const termTableBody = assertElement<HTMLTableSectionElement>('term-table-body', '#term-table-body');
const termSourceInput = assertElement<HTMLInputElement>('term-source', '#term-source');
const termTargetInput = assertElement<HTMLInputElement>('term-target', '#term-target');
const termLangInput = assertElement<HTMLInputElement>('term-lang', '#term-lang');
const addTermButton = assertElement<HTMLButtonElement>('add-term', '#add-term');
const exportTermsButton = assertElement<HTMLButtonElement>('export-terms', '#export-terms');
const importTermsInput = assertElement<HTMLInputElement>('import-terms-input', '#import-terms-input');
const importTermsButton = assertElement<HTMLButtonElement>('import-terms', '#import-terms');

function formToSettings(): BridgeSettings {
  return {
    bridgeUrl: bridgeUrlInput.value,
    pairingToken: pairingTokenInput.value,
    targetLanguage: targetLanguageInput.value,
    translatedFontFamily: translatedFontFamilyInput.value,
    translatedTextColor: translatedTextColorInput.value
  };
}

function applyPreview(settings: BridgeSettings): void {
  preview.style.color = settings.translatedTextColor;
  preview.style.fontFamily = settings.translatedFontFamily;
}

function renderBridgeCheck(message: string, tone: 'neutral' | 'success' | 'error' = 'neutral'): void {
  bridgeCheckStatus.dataset.tone = tone;
  bridgeCheckStatus.textContent = message;
}

function describeHealth(health: BridgeHealth): { tone: 'neutral' | 'success' | 'error'; message: string } {
  if (health.status === 'ready') {
    return { tone: 'success', message: `Bridge ready. ${health.message}` };
  }
  if (health.status === 'consent_required') {
    return { tone: 'error', message: `Copilot consent required. ${health.message}` };
  }
  if (health.status === 'copilot_unavailable') {
    return { tone: 'error', message: `Copilot unavailable. ${health.message}` };
  }
  if (health.status === 'not_paired') {
    return { tone: 'error', message: `Bridge not paired. ${health.message}` };
  }
  return { tone: 'error', message: health.message };
}

function applySettings(settings: BridgeSettings): void {
  bridgeUrlInput.value = settings.bridgeUrl;
  pairingTokenInput.value = settings.pairingToken;
  targetLanguageInput.value = settings.targetLanguage;
  translatedFontFamilyInput.value = settings.translatedFontFamily;
  translatedTextColorInput.value = settings.translatedTextColor;
  applyPreview(settings);
}

for (const control of [
  bridgeUrlInput,
  pairingTokenInput,
  targetLanguageInput,
  translatedFontFamilyInput,
  translatedTextColorInput
]) {
  control.addEventListener('input', () => {
    applyPreview(formToSettings());
    saveStatus.textContent = 'Unsaved changes.';
  });
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const saved = await saveSettings(formToSettings());
  applySettings(saved);
  saveStatus.textContent = '设置已保存。未来翻译立即应用。';
});

toggleTokenVisibilityButton.addEventListener('click', () => {
  const showing = pairingTokenInput.type === 'text';
  pairingTokenInput.type = showing ? 'password' : 'text';
  toggleTokenVisibilityButton.textContent = showing ? '显示 token' : '隐藏 token';
});

testBridgeButton.addEventListener('click', async () => {
  testBridgeButton.disabled = true;
  renderBridgeCheck('正在检查桥接和 Copilot 就绪状态…');
  try {
    const response = await fetchBridgeHealth(formToSettings());

    if (response.error) {
      renderBridgeCheck(response.error.message, 'error');
      return;
    }

    if (response.health) {
      const result = describeHealth(response.health);
      renderBridgeCheck(result.message, result.tone);
      return;
    }

    renderBridgeCheck('Bridge health unavailable.', 'error');
  } catch (error) {
    renderBridgeCheck(error instanceof Error ? error.message : 'Unable to query the local bridge.', 'error');
  } finally {
    testBridgeButton.disabled = false;
  }
});

void getSettings().then((settings) => {
  applySettings(settings);
  saveStatus.textContent = '已加载当前设置。';
  renderBridgeCheck('保存设置后点击"测试桥接"以确认本地桥接、Token 和 Copilot 访问正常。');
});

// --- Terminology management ---

function renderTermTable(table: TermTable): void {
  termTableBody.innerHTML = '';
  for (const term of table.terms) {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td style="padding:6px 8px;border-bottom:1px solid rgba(0,0,0,0.06);font-size:13px;color:#1f1b17;"><code style="word-break:break-all;">${escapeHtml(term.source)}</code></td>
      <td style="padding:6px 8px;border-bottom:1px solid rgba(0,0,0,0.06);font-size:13px;color:#275d84;"><code style="word-break:break-all;">${escapeHtml(term.target)}</code></td>
      <td style="padding:6px 8px;border-bottom:1px solid rgba(0,0,0,0.06);font-size:12px;color:#888;">${escapeHtml(term.languages)}</td>
      <td style="padding:6px 4px;border-bottom:1px solid rgba(0,0,0,0.06);">
        <button data-action="delete" data-source="${escapeHtml(term.source)}" style="border:0;border-radius:6px;background:#fdeaea;color:#c05050;padding:4px 10px;cursor:pointer;font-size:12px;">删除</button>
      </td>
    `;
    termTableBody.appendChild(row);
  }

  termTableBody.querySelectorAll('[data-action="delete"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const source = (btn as HTMLElement).dataset.source ?? '';
      const table = await getTermTable();
      table.terms = table.terms.filter((t) => t.source !== source);
      await saveTermTable(table);
      renderTermTable(table);
    });
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

addTermButton.addEventListener('click', async () => {
  const source = termSourceInput.value.trim();
  const target = termTargetInput.value.trim();
  const lang = termLangInput.value.trim() || 'auto-zh-CN';

  if (!source || !target) {
    return;
  }

  const table = await getTermTable();
  // Replace existing term with same source
  const existing = table.terms.findIndex((t) => t.source === source);
  const entry: TermEntry = {
    source,
    target,
    languages: lang,
    createdAt: Date.now()
  };

  if (existing >= 0) {
    table.terms[existing] = entry;
  } else {
    table.terms.push(entry);
  }

  await saveTermTable(table);
  renderTermTable(table);
  termSourceInput.value = '';
  termTargetInput.value = '';
  termSourceInput.focus();
});

exportTermsButton.addEventListener('click', async () => {
  const table = await getTermTable();
  const json = JSON.stringify(table, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'translate-helper-terms.json';
  a.click();
  URL.revokeObjectURL(url);
});

importTermsButton.addEventListener('click', () => {
  importTermsInput.click();
});

importTermsInput.addEventListener('change', async () => {
  const file = importTermsInput.files?.[0];
  if (!file) return;

  try {
    const text = await file.text();
    const imported = JSON.parse(text) as TermTable;
    if (!Array.isArray(imported.terms)) {
      alert('Invalid term table format.');
      return;
    }
    const current = await getTermTable();
    const merged = new Map<string, TermEntry>();
    for (const t of current.terms) {
      merged.set(t.source, t);
    }
    for (const t of imported.terms) {
      if (typeof t.source === 'string' && typeof t.target === 'string') {
        merged.set(t.source, {
          source: t.source,
          target: t.target,
          context: typeof t.context === 'string' ? t.context : undefined,
          languages: typeof t.languages === 'string' ? t.languages : 'auto-zh-CN',
          createdAt: typeof t.createdAt === 'number' ? t.createdAt : Date.now()
        });
      }
    }
    const table: TermTable = {
      version: 1,
      terms: Array.from(merged.values())
    };
    await saveTermTable(table);
    renderTermTable(table);
    alert(`已导入 ${table.terms.length} 条术语。`);
  } catch {
    alert('导入失败：文件格式错误。');
  }

  importTermsInput.value = '';
});

void getTermTable().then(renderTermTable);
