import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { CreatorRuntimeComponent } from '@opencreator/protocol';
import { CreatorExecutorError } from '../executor.js';

export type OcrLanguageCode =
  | 'eng'
  | 'vie'
  | 'chi_sim'
  | 'chi_tra'
  | 'jpn'
  | 'kor'
  | 'spa'
  | 'fra'
  | 'deu'
  | 'rus';

type OcrLanguageRelease = {
  packageName: string;
  sha256: string;
  bytes: number;
};

const releases: Record<OcrLanguageCode, OcrLanguageRelease> = {
  eng: { packageName: '@tesseract.js-data/eng', sha256: 'ed350f3752f81ee8f38769edc14d92d997dababe23b565c59879372cc46a2468', bytes: 10_923_060 },
  vie: { packageName: '@tesseract.js-data/vie', sha256: 'a2732b8e9f701e727dc7ad131581dad23b99c116465d2b5748416de26bde4c5e', bytes: 3_847_324 },
  chi_sim: { packageName: '@tesseract.js-data/chi_sim', sha256: '59388039851e4d1293d729c183fd8c1fa9bbbb959eed996e945024671e68c1d6', bytes: 20_159_757 },
  chi_tra: { packageName: '@tesseract.js-data/chi_tra', sha256: '67a4357a69810bf1596e801cd95299e073030cacb0899e78d9923d2fa1185704', bytes: 27_120_340 },
  jpn: { packageName: '@tesseract.js-data/jpn', sha256: '70304835d33b4feacf5faa60f56176578b64a03de2eeb0801539a3f6e7807ccc', bytes: 16_163_676 },
  kor: { packageName: '@tesseract.js-data/kor', sha256: '9d454186b4e2556854b625c43e44d93783a5be7ee89eb1dc6702dfbddced3f4f', bytes: 6_951_378 },
  spa: { packageName: '@tesseract.js-data/spa', sha256: '6cd52c545bceeacb2e43fad64fc0703a711c482ba20d1ca4b6915c09de9973e6', bytes: 8_362_819 },
  fra: { packageName: '@tesseract.js-data/fra', sha256: '1c0916fac2dbd6f121ca8a57a92f08e4a119227602c7c984da986222eab6cd3b', bytes: 6_279_601 },
  deu: { packageName: '@tesseract.js-data/deu', sha256: 'f5618a8b8d07f6c7a633ce243bf075bb90f4145bb15c9264734c7cc63aa33205', bytes: 7_101_284 },
  rus: { packageName: '@tesseract.js-data/rus', sha256: '63a48ae166be2bb9862839b6f75e11afbac5e3be5bd5fa9a155ea43d5cdf9575', bytes: 8_634_337 }
};

const require = createRequire(import.meta.url);
const verification = new Map<OcrLanguageCode, Promise<ManagedOcrLanguage>>();

export type ManagedOcrLanguage = {
  code: OcrLanguageCode;
  langPath: string;
  dataPath: string;
};

export function ocrLanguageCode(language?: string): OcrLanguageCode | undefined {
  if (!language) return undefined;
  const normalized = language.trim().toLowerCase().replaceAll('-', '_');
  if (normalized === 'auto') return undefined;
  if (normalized === 'zh_tw' || normalized === 'zh_hk' || normalized === 'zh_hant') return 'chi_tra';
  if (normalized.startsWith('zh') || normalized === 'chi') return 'chi_sim';
  if (normalized.startsWith('vi')) return 'vie';
  if (normalized.startsWith('ja')) return 'jpn';
  if (normalized.startsWith('ko')) return 'kor';
  if (normalized.startsWith('es')) return 'spa';
  if (normalized.startsWith('fr')) return 'fra';
  if (normalized.startsWith('de')) return 'deu';
  if (normalized.startsWith('ru')) return 'rus';
  if (normalized.startsWith('en')) return 'eng';
  return undefined;
}

export function supportedOcrLanguage(language?: string): boolean {
  return ocrLanguageCode(language) !== undefined;
}

export async function resolveManagedOcrLanguage(language?: string): Promise<ManagedOcrLanguage> {
  const code = ocrLanguageCode(language);
  if (code === undefined) {
    throw new CreatorExecutorError(
      'creator_ocr_language_unsupported',
      `OCR does not support the selected source language: ${language ?? 'auto'}`
    );
  }
  let pending = verification.get(code);
  if (pending === undefined) {
    pending = verifyLanguage(code).catch(error => {
      verification.delete(code);
      throw error;
    });
    verification.set(code, pending);
  }
  return pending;
}

export type OcrComponentManager = ReturnType<typeof createOcrComponentManager>;

export function createOcrComponentManager() {
  return {
    async ensure(language?: string) {
      return resolveManagedOcrLanguage(language);
    },
    async status(): Promise<CreatorRuntimeComponent> {
      const models = await Promise.all((Object.keys(releases) as OcrLanguageCode[]).map(async code => ({
        id: code,
        installed: await resolveManagedOcrLanguage(code).then(() => true, () => false),
        bytes: releases[code].bytes
      })));
      const ready = models.every(model => model.installed);
      return {
        id: 'tesseract',
        name: 'Tesseract OCR',
        available: true,
        version: ready ? '6.0.1-wasm' : null,
        supportedVersion: '6.0.1-wasm',
        installedAt: null,
        path: dirname(require.resolve('tesseract.js/package.json')),
        source: 'npm packages · pinned versions · SHA-256 verified',
        models,
        state: ready ? 'ready' : 'partial',
        model: null,
        item: null,
        downloadedBytes: 0,
        totalBytes: models.reduce((sum, model) => sum + (model.bytes ?? 0), 0),
        percent: ready ? 100 : null,
        bytesPerSecond: null,
        remainingSeconds: null,
        error: ready ? null : 'One or more packaged OCR language models failed verification'
      };
    },
    async download(): Promise<void> {
      await Promise.all((Object.keys(releases) as OcrLanguageCode[]).map(code => resolveManagedOcrLanguage(code)));
    },
    close() {}
  };
}

async function verifyLanguage(code: OcrLanguageCode): Promise<ManagedOcrLanguage> {
  const release = releases[code];
  let packageRoot: string;
  try {
    packageRoot = dirname(require.resolve(`${release.packageName}/package.json`));
  } catch (cause) {
    throw new CreatorExecutorError(
      'creator_ocr_engine_missing',
      `Packaged OCR language data is missing for ${code}`,
      {},
      undefined,
      { cause }
    );
  }
  const langPath = join(packageRoot, '4.0.0');
  const dataPath = join(langPath, `${code}.traineddata.gz`);
  const info = await stat(dataPath).catch(() => undefined);
  if (!info?.isFile() || info.size !== release.bytes || await sha256File(dataPath) !== release.sha256) {
    throw new CreatorExecutorError(
      'creator_ocr_engine_missing',
      `Packaged OCR language data failed verification for ${code}`
    );
  }
  return { code, langPath, dataPath };
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
