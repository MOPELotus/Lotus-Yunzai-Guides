import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("guides", messageCatalog.messages);
import { constants, renameSync } from "node:fs";
import { mkdir, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { Job } from "node-schedule";
import type { MessageReply } from "../../lib/messages.ts";
import { GuideSettingsError } from "./guide-configuration.ts";

export type CalendarScheduleKind = "S" | "G" | "*";
type Outcome = "confirmed" | "rejected" | "unknown";

export interface CalendarScheduleTarget {
  readonly groupId: number;
  readonly inlineImageByteLimit?: number;
  send(message: MessageReply, signal: AbortSignal): Promise<Outcome>;
}

export interface CalendarScheduleOwner {
  /** Bound by the host to the current protocol, bot, sender and conversation. */
  readonly key: string;
  readonly signal: AbortSignal;
}

export interface CalendarScheduleOptions {
  readonly root: URL;
  readonly signal: AbortSignal;
  lockFile(file: string, subject: string): Promise<{ close(): void }>;
  register(cron: string, type: CalendarScheduleKind, run: () => Promise<void>): () => void | Promise<void>;
  targets(groupIds: readonly number[], signal: AbortSignal): Promise<readonly CalendarScheduleTarget[]>;
  render(type: CalendarScheduleKind, signal: AbortSignal, inlineImageByteLimit?: number): Promise<MessageReply | undefined>;
  report?(stage: "state" | "register" | "targets" | "render" | "send", outcome: Exclude<Outcome, "confirmed">): void;
  wait?(milliseconds: number, signal: AbortSignal): Promise<void>;
}

export interface CalendarSchedule {
  matchesCommand(message: string): boolean;
  handle(message: string, owner?: CalendarScheduleOwner): Promise<string | undefined>;
  readSettings(): Promise<CalendarScheduleSettings>;
  writeSettings(previous: unknown, next: unknown, session: {
    readonly signal: AbortSignal;
    readonly canWrite: () => boolean;
  }): Promise<CalendarScheduleSettings>;
  stop(): Promise<void>;
}

interface Task {
  readonly cron: string;
  readonly type: CalendarScheduleKind;
}

export interface CalendarScheduleSettings {
  readonly whiteList: readonly number[];
  readonly blackList: readonly number[];
  readonly tasks: readonly Task[];
}

interface State extends CalendarScheduleSettings {
  readonly version: 1;
}

const empty: State = { version: 1, whiteList: [], blackList: [], tasks: [] };
const oneStep = /^#定时(?:任务表|群聊表|添加群聊[黑白]名单)$/u;
const addTask = /^#定时添加任务(?:\s|$)/u;
const taskSyntax = /^#定时添加任务 time="([^"\r\n]+)" (S|G|\*)$/u;
const stateName = "calendar-schedule.json";
const legacyNames = ["AutoCalendarWhiteList.json", "AutoCalendarBlackList.json", "AutoCalendarTasks.json"] as const;
const maxStateBytes = 128 * 1024;
const maxGroups = 1024;
const maxTasks = 64;
const maxPrompts = 256;
const labels = { S: $t("calendar-schedule.text_e9905d6bf8"), G: $t("calendar-schedule.text_f3ad512a40"), "*": $t("calendar-schedule.text_80e4debfc8") } as const;

export function matchesCalendarScheduleCommand(message: string): boolean {
  return oneStep.test(message) || addTask.test(message);
}

function groupId(value: unknown): number | undefined {
  const id = typeof value === "string" && /^[1-9]\d*$/u.test(value) ? Number(value) : value;
  if (typeof id === "number" && Number.isSafeInteger(id) && id > 0) return id;
}

function taskKey({ cron, type }: Task): string {
  return `${type}:${cron.split(" ").length === 5 ? `0 ${cron}` : cron}`;
}

function task(cron: unknown, type: unknown): Task | undefined {
  if (typeof cron !== "string" || cron.length > 160 || !/^[\w*?,/#\- \t]+$/u.test(cron) ||
      (type !== "S" && type !== "G" && type !== "*")) return;
  const normalized = cron.trim().replace(/[ \t]+/gu, " ");
  if (![5, 6].includes(normalized.split(" ").length)) return;
  const probe = new Job(() => {});
  try {
    if (probe.schedule(normalized)) return { cron: normalized, type };
  } catch {
    return;
  } finally {
    probe.cancel();
  }
}

function groupList(value: unknown): readonly number[] {
  if (!Array.isArray(value) || value.length > maxGroups) throw new Error($t("calendar-schedule.text_e153d8f992"));
  const groups = new Set<number>();
  for (const entry of value) {
    const id = groupId(entry);
    if (id === undefined) throw new Error($t("calendar-schedule.text_4742cbb6a9"));
    groups.add(id);
  }
  return [...groups];
}

function taskList(value: unknown): readonly Task[] {
  if (!Array.isArray(value) || value.length > maxTasks) throw new Error($t("calendar-schedule.text_5205fa08db"));
  const tasks = new Map<string, Task>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error($t("calendar-schedule.text_b261acfe28"));
    const valid = task(entry.cron, entry.type);
    if (!valid) throw new Error($t("calendar-schedule.text_b7839603ed"));
    const key = taskKey(valid);
    if (!tasks.has(key)) tasks.set(key, valid);
  }
  return [...tasks.values()];
}

async function readSource(file: string): Promise<string | undefined> {
  const source = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  if (!source) return;
  try {
    const metadata = await source.stat();
    if (!metadata.isFile() || metadata.size > maxStateBytes) throw new Error($t("calendar-schedule.text_71d9706d5e"));
    const buffer = Buffer.alloc(metadata.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await source.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length !== metadata.size) throw new Error($t("calendar-schedule.text_90d8c13fb9"));
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
  } finally {
    await source.close();
  }
}

function stateRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function currentState(data: unknown): State {
  if (!stateRecord(data) || data.version !== 1) throw new Error($t("calendar-schedule.text_b842be8a1b"));
  return { version: 1, whiteList: groupList(data.whiteList), blackList: groupList(data.blackList), tasks: taskList(data.tasks) };
}

function panelState(input: unknown): State {
  if (!stateRecord(input) || Object.keys(input).length !== 3 ||
      !Object.hasOwn(input, "whiteList") || !Object.hasOwn(input, "blackList") || !Object.hasOwn(input, "tasks")) {
    throw new GuideSettingsError("input");
  }
  if (!Array.isArray(input.tasks) || input.tasks.some((entry: unknown) => !stateRecord(entry) ||
      Object.keys(entry).length !== 2 || !Object.hasOwn(entry, "cron") || !Object.hasOwn(entry, "type"))) {
    throw new GuideSettingsError("input");
  }
  try { return currentState({ ...input, version: 1 }); }
  catch { throw new GuideSettingsError("input"); }
}

function settingsOf({ whiteList, blackList, tasks }: State): CalendarScheduleSettings {
  return { whiteList, blackList, tasks };
}

export async function prepareLegacyCalendar(file: string) {
  const source = await readSource(file);
  if (source === undefined) throw new Error($t("calendar-schedule.text_6fcdb835e0"));
  const data: unknown = JSON.parse(source);
  if (!stateRecord(data) || Object.keys(data).some((key) => !["version", "whiteList", "blackList", "tasks"].includes(key)) ||
      !Array.isArray(data.tasks) || data.tasks.some((entry: unknown) =>
        !stateRecord(entry) || Object.keys(entry).some((key) => key !== "cron" && key !== "type"))) {
    throw new Error($t("calendar-schedule.text_696e51e73c"));
  }
  const state = currentState(data);
  const { whiteList, blackList, tasks } = state;
  return {
    counts: { whiteList: whiteList.length, blackList: blackList.length, tasks: tasks.length },
    files: {
      [legacyNames[0]]: `${JSON.stringify(whiteList.map(String), null, 2)}\n`,
      [legacyNames[1]]: `${JSON.stringify(blackList.map(String), null, 2)}\n`,
      [legacyNames[2]]: `${JSON.stringify(tasks, null, 2)}\n`,
    },
  };
}

function calendarScheduleStore(options: CalendarScheduleOptions) {
  const directory = fileURLToPath(new URL("data/guides/", options.root));
  const legacy = fileURLToPath(new URL("plugins/example/", options.root));
  const file = join(directory, stateName);

  async function sources(): Promise<readonly (string | undefined)[]> {
    const current = await readSource(file);
    if (current !== undefined) return [current];
    return [undefined, ...await Promise.all(legacyNames.map((name) => readSource(join(legacy, name))))];
  }

  function decode([current, white, black, tasks]: readonly (string | undefined)[]): State {
    if (current === undefined) {
      return {
        version: 1,
        whiteList: white === undefined ? [] : groupList(JSON.parse(white)),
        blackList: black === undefined ? [] : groupList(JSON.parse(black)),
        tasks: tasks === undefined ? [] : taskList(JSON.parse(tasks)),
      };
    }
    return currentState(JSON.parse(current));
  }

  return {
    async read() { return decode(await sources()); },
    async update(change: (state: State) => State, signal: AbortSignal, canWrite?: () => boolean): Promise<{ state: State; changed: boolean }> {
      signal.throwIfAborted();
      if (canWrite && !canWrite()) throw new GuideSettingsError("permission");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const lock = await options.lockFile(join(directory, ".calendar-schedule.sqlite"), $t("calendar-schedule.text_2b63a57e40"));
      try {
        signal.throwIfAborted();
        const previous = await sources();
        const current = decode(previous);
        const state = change(current);
        if (canWrite && !canWrite()) throw new GuideSettingsError("permission");
        if (state === current) return { state, changed: false };
        const bytes = Buffer.from(JSON.stringify(state, null, 2) + "\n");
        if (bytes.length > maxStateBytes) throw new Error($t("calendar-schedule.text_a78bcddcec"));
        const staging = join(directory, `.${stateName}.${crypto.randomUUID()}.tmp`);
        const destination = await open(staging, "wx", 0o600);
        try {
          try {
            await destination.writeFile(bytes);
            await destination.sync();
          } finally {
            await destination.close();
          }
          const latest = await sources();
          if (latest.length !== previous.length || latest.some((source, index) => source !== previous[index])) {
            throw new Error($t("calendar-schedule.text_1929dbad8b"));
          }
          signal.throwIfAborted();
          if (canWrite && !canWrite()) throw new GuideSettingsError("permission");
          renameSync(staging, file);
        } finally {
          await unlink(staging).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
          });
        }
        return { state, changed: true };
      } finally {
        lock.close();
      }
    },
  };
}

export async function createCalendarSchedule(options: CalendarScheduleOptions): Promise<CalendarSchedule> {
  const controller = new AbortController();
  const signal = AbortSignal.any([options.signal, controller.signal]);
  const store = calendarScheduleStore(options);
  const jobs = new Map<string, () => void | Promise<void>>();
  const running = new Map<string, Promise<void>>();
  const prompts = new Map<string, { list: "whiteList" | "blackList"; signal: AbortSignal; expires: number }>();
  let state = empty;
  let queue = Promise.resolve();
  let stopping: Promise<void> | undefined;
  let lastDelivery: number | undefined;
  const wait = options.wait ?? ((milliseconds: number, active: AbortSignal) => delay(milliseconds, undefined, { signal: active, ref: false }));

  async function send(type: CalendarScheduleKind, registered: () => boolean) {
    const active = () => !signal.aborted && registered();
    if (!active()) return;
    const denied = new Set(state.blackList);
    const selected = new Set(state.whiteList.filter((id) => !denied.has(id)));
    if (!selected.size) return;
    let targets: readonly CalendarScheduleTarget[];
    try {
      targets = await options.targets([...selected], signal);
    } catch {
      if (active()) options.report?.("targets", "unknown");
      return;
    }
    const queue = targets.filter(({ groupId }) => selected.delete(groupId));
    if (!queue.length || !active()) return;
    const rendered = new Map<number | undefined, MessageReply | undefined>();
    for (const target of queue) {
      if (!active()) return;
      if (!state.whiteList.includes(target.groupId) || state.blackList.includes(target.groupId)) continue;
      const limit = target.inlineImageByteLimit;
      if (!rendered.has(limit)) {
        try {
          const message = await options.render(type, signal, limit);
          if (message === undefined || Array.isArray(message) && !message.length) {
            if (active()) options.report?.("render", "rejected");
            rendered.set(limit, undefined);
          } else rendered.set(limit, message);
        } catch {
          if (active()) options.report?.("render", "unknown");
          rendered.set(limit, undefined);
        }
      }
      const message = rendered.get(limit);
      if (message === undefined) continue;
      if (!active()) return;
      if (!state.whiteList.includes(target.groupId) || state.blackList.includes(target.groupId)) continue;
      const remaining = lastDelivery === undefined ? 0 : 5000 - (performance.now() - lastDelivery);
      if (remaining > 0) {
        try { await wait(Math.ceil(remaining), signal); } catch { return; }
        if (!active()) return;
        if (!state.whiteList.includes(target.groupId) || state.blackList.includes(target.groupId)) continue;
      }
      let outcome: Outcome;
      try { outcome = await target.send(message, signal); } catch { outcome = "unknown"; }
      lastDelivery = performance.now();
      if (outcome !== "confirmed") options.report?.("send", outcome);
    }
  }

  function trigger(key: string, type: CalendarScheduleKind): Promise<void> {
    const registration = jobs.get(key);
    if (signal.aborted || !registration) return Promise.resolve();
    const current = running.get(key);
    if (current) return current;
    const next = queue.then(() => send(type, () => jobs.get(key) === registration)).finally(() => running.delete(key));
    queue = next.catch(() => {});
    running.set(key, next);
    return next;
  }

  function register(entry: Task): boolean {
    if (signal.aborted) return false;
    const key = taskKey(entry);
    if (jobs.has(key)) return true;
    try {
      jobs.set(key, options.register(entry.cron, entry.type, () => trigger(key, entry.type)));
      return true;
    } catch {
      options.report?.("register", "rejected");
      return false;
    }
  }

  async function writeSettings(previousValue: unknown, nextValue: unknown, session: {
    readonly signal: AbortSignal; readonly canWrite: () => boolean;
  }) {
    const previous = panelState(previousValue), next = panelState(nextValue);
    const active = AbortSignal.any([signal, session.signal]);
    const allowed = () => !active.aborted && session.canWrite();
    const result = await store.update(current => {
      if (!isDeepStrictEqual(current, previous)) throw new GuideSettingsError("conflict");
      return isDeepStrictEqual(current, next) ? current : next;
    }, active, allowed);
    state = result.state;
    const taskKeys = new Set(state.tasks.map(taskKey));
    const removed = [];
    for (const [key, dispose] of jobs) {
      if (taskKeys.has(key)) continue;
      jobs.delete(key);
      removed.push(dispose);
    }
    for (const task of state.tasks) register(task);
    await Promise.allSettled(removed.map(async dispose => dispose()));
    return settingsOf(state);
  }

  const stop = (): Promise<void> => stopping ??= (async () => {
    controller.abort();
    options.signal.removeEventListener("abort", onAbort);
    prompts.clear();
    const disposers = [...jobs.values()];
    jobs.clear();
    await Promise.allSettled([...disposers.map(async (dispose) => dispose()), queue]);
  })();
  const onAbort = () => { void stop(); };
  options.signal.addEventListener("abort", onAbort, { once: true });

  if (!signal.aborted) {
    try {
      state = await store.read();
      for (const entry of state.tasks) register(entry);
    } catch {
      if (!signal.aborted) options.report?.("state", "rejected");
    }
  }

  async function handle(message: string, owner?: CalendarScheduleOwner): Promise<string | undefined> {
    const command = matchesCalendarScheduleCommand(message);
    if (signal.aborted) return;
    if (!owner || owner.signal.aborted || !owner.key) return command ? $t("calendar-schedule.text_92c201c29a") : undefined;
    const active = AbortSignal.any([signal, owner.signal]);
    const pending = prompts.get(owner.key);
    if (pending && (pending.signal.aborted || pending.expires <= performance.now())) prompts.delete(owner.key);

    if (message === "#定时添加群聊白名单" || message === "#定时添加群聊黑名单") {
      prompts.delete(owner.key);
      if (prompts.size >= maxPrompts) {
        const oldest = prompts.keys().next();
        if (!oldest.done) prompts.delete(oldest.value);
      }
      prompts.set(owner.key, {
        list: message === "#定时添加群聊白名单" ? "whiteList" : "blackList",
        signal: owner.signal, expires: performance.now() + 60_000,
      });
      return $t("calendar-schedule.text_392b3c6616");
    }

    try {
      if (message === "#定时群聊表" || message === "#定时任务表") {
        const current = await store.read();
        if (active.aborted) return;
        return message === "#定时群聊表"
          ? $t("calendar-schedule.text_c969a31cec", { "value1": current.whiteList.join(", ") || $t("calendar-schedule.text_484d556139"), "value2": current.blackList.join(", ") || $t("calendar-schedule.text_484d556139") })
          : $t("calendar-schedule.text_ac9cecfcdd") + (current.tasks.map(({ cron, type }, index) =>
            $t("calendar-schedule.text_e3bc6225fb", { "value1": index + 1, "cron": cron, "value3": labels[type] })).join("\n") || $t("calendar-schedule.text_da9688984c"));
      }
      if (addTask.test(message)) {
        const match = taskSyntax.exec(message);
        const entry = match && task(match[1], match[2]);
        if (!entry) return $t("calendar-schedule.text_3fb24bd660");
        const result = await store.update((current) => {
          if (current.tasks.some((item) => taskKey(item) === taskKey(entry))) return current;
          if (current.tasks.length >= maxTasks) throw new Error($t("calendar-schedule.text_ff959e20bb"));
          return { ...current, tasks: [...current.tasks, entry] };
        }, active);
        state = result.state;
        if (active.aborted) return;
        const scheduled = register(entry);
        if (!scheduled) return $t("calendar-schedule.text_3c7a7da6e6");
        return result.changed ? $t("calendar-schedule.text_4b4ca7e1eb", { "cron": entry.cron, "value2": labels[entry.type] }) : $t("calendar-schedule.text_65e93eb60e");
      }
      const prompt = prompts.get(owner.key);
      if (!prompt) return;
      if (message === "取消" || message === "#取消") {
        prompts.delete(owner.key);
        return $t("calendar-schedule.text_8f64c69a95");
      }
      if (message.startsWith("#")) return;
      const id = groupId(message.trim());
      if (id === undefined) return $t("calendar-schedule.text_400ae55a6d");
      prompts.delete(owner.key);
      const result = await store.update((current) => {
        if (current[prompt.list].includes(id)) return current;
        if (current[prompt.list].length >= maxGroups) throw new Error($t("calendar-schedule.text_1922089e92"));
        return { ...current, [prompt.list]: [...current[prompt.list], id] };
      }, AbortSignal.any([active, prompt.signal]));
      state = result.state;
      if (!active.aborted && !prompt.signal.aborted) return result.changed ? $t("calendar-schedule.text_e669edb409", { "id": id }) : $t("calendar-schedule.text_b96173785e", { "id": id });
    } catch {
      if (!active.aborted) {
        options.report?.("state", "rejected");
        return $t("calendar-schedule.text_832d4d15b4");
      }
    }
  }

  return { matchesCommand: matchesCalendarScheduleCommand, handle, stop,
    readSettings: async () => settingsOf(await store.read()), writeSettings };
}
