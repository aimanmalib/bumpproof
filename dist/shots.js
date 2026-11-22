// Kane CLI step screenshots for the report (PRD D14): the step that failed on the head, and the same step on the
// base and after the fix. Only the JPEG/PNG bytes leave the evidence pack. Metadata segments are dropped before
// anything is written, and the publication scan reads whatever text an image still carries.
import { strFromU8, unzlibSync } from 'fflate';
/**
 * Steps of the final attempt: `tests/<name>-<hash>/steps/<ordinal>-<id>/step.json`. Earlier healing attempts live
 * one folder deeper (`tests/<name>-<hash>/<n>/steps/…`) and are ignored.
 */
export function packSteps(pack) {
    const out = [];
    for (const [path, bytes] of pack) {
        const m = /^tests\/[^/]+\/steps\/((\d+)-([^/]+))\/step\.json$/.exec(path);
        if (!m)
            continue;
        let status = '';
        try {
            const v = JSON.parse(strFromU8(bytes));
            if (v && typeof v === 'object' && typeof v.status === 'string')
                status = v.status;
        }
        catch { /* unreadable step: no status */ }
        out.push({ id: m[3], dir: path.slice(0, -'step.json'.length), status, ordinal: Number(m[2]) });
    }
    return out.sort((a, b) => a.ordinal - b.ordinal);
}
/** Id (such as `3-4`) of the last failed step, or null when no step failed. */
export function failedStepId(pack) {
    return packSteps(pack).filter((s) => s.status === 'failed').at(-1)?.id ?? null;
}
/** Screenshot bytes of one step, or null when the pack has none for it. */
export function stepShot(pack, id, exts) {
    const step = packSteps(pack).find((s) => s.id === id);
    if (!step)
        return null;
    for (const ext of exts) {
        const bytes = pack.get(`${step.dir}screenshot.${ext}`);
        if (bytes)
            return { bytes, ext };
    }
    return null;
}
const isJpeg = (b) => b[0] === 0xff && b[1] === 0xd8;
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const isPng = (b) => PNG_SIG.every((x, i) => b[i] === x);
/** JPEG segments up to the start of scan; null when the bytes are not a well-formed JPEG header. */
function jpegSegments(b) {
    if (!isJpeg(b))
        return null;
    const segments = [];
    let i = 2;
    while (i + 4 <= b.length && b[i] === 0xff) {
        const marker = b[i + 1];
        if (marker === 0xda)
            return { segments, scan: i };
        const len = (b[i + 2] << 8) | b[i + 3];
        if (len < 2 || i + 2 + len > b.length)
            return null;
        segments.push({ marker, start: i, end: i + 2 + len, data: b.subarray(i + 4, i + 2 + len) });
        i += 2 + len;
    }
    return null;
}
const startsWith = (d, s) => [...s].every((c, i) => d[i] === c.charCodeAt(0));
/** Keeps JFIF (APP0) and the colour profile (APP2 ICC_PROFILE); drops EXIF, XMP, other APPn and comments. */
export function stripJpegMetadata(b) {
    const parsed = jpegSegments(b);
    if (!parsed)
        throw new Error('not a JPEG');
    const keep = parsed.segments.filter((s) => {
        if (s.marker === 0xfe)
            return false;
        if (s.marker === 0xe0)
            return true;
        if (s.marker === 0xe2)
            return startsWith(s.data, 'ICC_PROFILE\0');
        return !(s.marker >= 0xe1 && s.marker <= 0xef);
    });
    const parts = [b.subarray(0, 2), ...keep.map((s) => b.subarray(s.start, s.end)), b.subarray(parsed.scan)];
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
        out.set(p, o);
        o += p.length;
    }
    return out;
}
/** Printable ASCII runs of four or more characters, one per line, so the text scan sees e-mail and links. */
function printable(d) {
    return (strFromU8(d, true).match(/[\x20-\x7e]{4,}/g) ?? []).join('\n');
}
/**
 * Text an image carries outside its pixels: JPEG APPn/COM segments other than the colour profile, PNG
 * tEXt/zTXt/iTXt/eXIf chunks. Unknown formats return their printable runs, which errs on the side of a finding.
 */
export function imageText(b) {
    const jpeg = jpegSegments(b);
    if (jpeg) {
        return jpeg.segments.filter((s) => s.marker === 0xfe || (s.marker >= 0xe1 && s.marker <= 0xef && !startsWith(s.data, 'ICC_PROFILE\0')))
            .map((s) => printable(s.data)).join('\n');
    }
    if (isPng(b)) {
        const parts = [];
        let i = 8;
        while (i + 12 <= b.length) {
            const len = ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
            const type = strFromU8(b.subarray(i + 4, i + 8), true);
            const data = b.subarray(i + 8, Math.min(i + 8 + len, b.length));
            if (type === 'tEXt' || type === 'iTXt' || type === 'eXIf')
                parts.push(printable(data));
            if (type === 'zTXt') {
                const z = data.indexOf(0);
                try {
                    parts.push(printable(data.subarray(0, z)), printable(unzlibSync(data.subarray(z + 2))));
                }
                catch {
                    parts.push(printable(data));
                }
            }
            i += 12 + len;
        }
        return parts.join('\n');
    }
    return printable(b);
}
/** Bytes as they will be published: JPEG metadata dropped; other formats unchanged (the scan still reads them). */
export function publishable(b) {
    return isJpeg(b) ? stripJpegMetadata(b) : b;
}
/**
 * For every journey whose head run failed at a step: that step's screenshot on the head, then the same step on the
 * base and after the fix when those packs have it. Files are named `shots/<journey>-<side>.<ext>`.
 */
export function collectShots(report, packOf, exts) {
    const shots = [];
    const files = [];
    for (const j of report.journeys) {
        if (j.head?.status !== 'failed')
            continue;
        const head = packOf(j.name, 'head');
        const id = head ? failedStepId(head) : null;
        if (!head || !id)
            continue;
        for (const side of ['base', 'head', 'after_fix']) {
            const pack = side === 'head' ? head : packOf(j.name, side);
            const shot = pack ? stepShot(pack, id, exts) : null;
            if (!shot)
                continue;
            const file = `shots/${j.name.replace(/[^\w-]/g, '_')}-${side}.${shot.ext}`;
            shots.push({ journey: j.name, side, file });
            files.push({ file, bytes: publishable(shot.bytes) });
        }
    }
    return { shots, files };
}
