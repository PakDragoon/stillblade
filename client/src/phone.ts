/**
 * The phone notice: a touch device with no mouse cannot play, so it is told before anything is loaded.
 * `?desktop=1` and the "Continue anyway" link skip it (some touch laptops report a coarse pointer).
 */

/** The slice of `window.matchMedia` this needs, so tests can fake it. */
export type MediaQuery = (query: string) => { matches: boolean };

/** True when the primary pointer is coarse and cannot hover: a phone or a tablet without a mouse. */
export function isTouchOnly(matchMedia: MediaQuery | undefined): boolean {
    if (!matchMedia) return false;
    try {
        return matchMedia('(pointer: coarse)').matches && matchMedia('(hover: none)').matches;
    } catch {
        return false;
    }
}

/** Copies `text`: the clipboard if it is allowed, else selects it in `fallback` so the player can copy by hand. */
export async function copyText(text: string, fallback: HTMLInputElement): Promise<boolean> {
    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch { /* refused: fall back to selecting it */ }
    fallback.style.display = 'block';
    fallback.value = text;
    fallback.focus();
    fallback.select();
    try { return document.execCommand('copy'); } catch { return false; }
}

/**
 * Shows the full-screen message and resolves when the player chooses to continue anyway.
 * Never resolves otherwise, so nothing behind it starts.
 */
export function showPhoneNotice(link: string): Promise<void> {
    return new Promise(resolve => {
        const box = document.createElement('div');
        box.id = 'phone-notice';
        box.style.cssText = 'position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:24px;' +
            'background:radial-gradient(ellipse at 50% 30%,#172029 0%,#0a0d11 70%);color:#e7eae5;text-align:center;' +
            "font:16px/1.5 'Bahnschrift','Segoe UI',system-ui,sans-serif";
        const card = document.createElement('div');
        card.style.cssText = 'max-width:420px;display:grid;gap:16px;justify-items:center';
        const title = document.createElement('h1');
        title.textContent = 'STILLBLADE';
        title.style.cssText = 'margin:0;font-size:34px;letter-spacing:.22em;font-weight:800';
        const text = document.createElement('p');
        text.textContent = 'Stillblade needs a mouse and a keyboard. Open this page on a computer to play.';
        text.style.cssText = 'margin:0;font-size:18px';
        const note = document.createElement('p');
        note.textContent = 'Copy the link now and open it later on your computer.';
        note.style.cssText = 'margin:0;color:#8a97a2';
        const copy = document.createElement('button');
        copy.type = 'button';
        copy.textContent = 'Copy page link';
        copy.style.cssText = 'font-weight:700;font-size:16px;font-family:inherit;padding:14px 22px;border:0;background:#e7eae5;color:#0b0e12;cursor:pointer;min-height:48px';
        const field = document.createElement('input');
        field.type = 'text';
        field.readOnly = true;
        field.style.cssText = 'display:none;width:100%;padding:10px;background:#10151b;color:#e7eae5;border:1px solid #394450;font-size:14px';
        field.setAttribute('aria-label', 'Page link');
        const status = document.createElement('p');
        status.setAttribute('role', 'status');
        status.style.cssText = 'margin:0;min-height:1.5em;color:#7fe0c4';
        const cont = document.createElement('a');
        cont.href = '#';
        cont.textContent = 'Continue anyway';
        cont.style.cssText = 'color:#8a97a2;font-size:14px;padding:12px';
        copy.addEventListener('click', () => {
            void copyText(link, field).then(ok => { status.textContent = ok ? 'Link copied.' : 'Select the link above and copy it.'; });
        });
        cont.addEventListener('click', e => { e.preventDefault(); box.remove(); resolve(); });
        card.append(title, text, note, copy, field, status, cont);
        box.append(card);
        document.body.append(box);
    });
}
