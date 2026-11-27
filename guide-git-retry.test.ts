import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareGuideSourceGit } from "./team-resources.ts";
import type { ResourceProgress } from "../../lib/resource-progress.ts";

async function fixture(failures: number, run: (root: string, attempts: () => Promise<number>) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "lotus-guide-git-retry-"));
  const previous = Bun.env.PATH;
  try {
    const bin = join(root, "bin"), repo = join(root, "repo");
    await mkdir(bin); await mkdir(repo);
    await writeFile(join(bin, "git"), `#!${process.execPath}\nimport {readFileSync,writeFileSync,existsSync} from 'node:fs';\nconst args=process.argv.slice(2);\nif(args.includes('fetch')){const file='attempts';const n=(existsSync(file)?Number(readFileSync(file,'utf8')):0)+1;writeFileSync(file,String(n));if(n<=${failures}){process.stderr.write("fatal: unable to access 'https://user:private-password@example.invalid/repo.git?token=private-token': gnutls_handshake() failed\\n");process.exit(128);}}\nif(args.includes('remote')&&!args.includes('set-url'))process.stdout.write('origin\\n');\n`, { mode: 0o755 });
    Bun.env.PATH = bin + ":" + previous;
    await run(repo, async () => Number(await readFile(join(repo, "attempts"), "utf8")));
  } finally {
    if (previous === undefined) delete Bun.env.PATH; else Bun.env.PATH = previous;
    await rm(root, { recursive: true, force: true });
  }
}

test("guide fetch retries two transient TLS failures with visible bounded progress", () => fixture(2, async (root, attempts) => {
  const progress: ResourceProgress[] = [];
  const git = await prepareGuideSourceGit(root, "https://example.invalid/repo.git", new AbortController().signal, event => progress.push(event));
  expect(typeof git).toBe("function");
  expect(await attempts()).toBe(3);
  expect(progress.filter(event => event.stage === "guides-git-retry")).toHaveLength(2);
  expect(JSON.stringify(progress)).toContain("gnutls_handshake");
  expect(JSON.stringify(progress)).not.toContain("private-password");
  expect(JSON.stringify(progress)).not.toContain("private-token");
}));

test("permanent guide fetch failure retains a sanitized diagnostic after exactly three attempts", () => fixture(99, async (root, attempts) => {
  let failure: unknown;
  try { await prepareGuideSourceGit(root, "https://example.invalid/repo.git", new AbortController().signal); } catch (error) { failure = error; }
  expect(String(failure)).toContain("Git fetch");
  expect(String(failure)).toContain("gnutls_handshake");
  expect(String(failure)).toContain("https://example.invalid/repo.git");
  expect(String(failure)).not.toContain("private-password");
  expect(String(failure)).not.toContain("private-token");
  expect(await attempts()).toBe(3);
}));

test("cancelling a guide retry prevents another Git request", () => fixture(99, async (root, attempts) => {
  const controller = new AbortController();
  await expect(prepareGuideSourceGit(root, "https://example.invalid/repo.git", controller.signal, event => {
    if (event.stage === "guides-git-retry") controller.abort();
  })).rejects.toThrow();
  expect(await attempts()).toBe(1);
}));
