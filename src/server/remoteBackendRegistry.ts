import { randomUUID } from "node:crypto";
import type { RemoteBackendCommand, RemoteBackendExecutor } from "../core/remoteBackend.js";

type Binding = {
  sessionId: string;
  transportId: string;
  generation: string;
  send: (message: unknown) => void;
};

type Pending = {
  sessionId: string;
  command: RemoteBackendCommand;
  fingerprint: string;
  promise: Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type Completion = {
  sessionId: string;
  command: RemoteBackendCommand;
  fingerprint: string;
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type Completed = {
  sessionId: string;
  command: RemoteBackendCommand;
  fingerprint: string;
  result?: unknown;
  error?: Error;
  completionError?: Error;
};

/** Parent-side command router. It owns only remote request promises, never thread state. */
export class RemoteBackendRegistry implements RemoteBackendExecutor {
  private readonly bindings = new Map<string, Binding>();
  private readonly pending = new Map<string, Pending>();
  private readonly completions = new Map<string, Completion>();
  private readonly completed = new Map<string, Completed>();

  attach(binding: Binding) {
    this.bindings.set(binding.sessionId, binding);
    for (const pending of this.pending.values()) {
      if (pending.sessionId !== binding.sessionId) continue;
      this.send(binding, pending.command);
    }
    for (const completion of this.completions.values()) {
      if (completion.sessionId !== binding.sessionId) continue;
      if (!this.pending.has(completion.command.commandId)) this.send(binding, completion.command);
    }
  }

  detach(sessionId: string, transportId: string) {
    const current = this.bindings.get(sessionId);
    if (current?.transportId === transportId) this.bindings.delete(sessionId);
  }

  dispose(sessionId: string) {
    this.bindings.delete(sessionId);
    for (const [commandId, pending] of this.pending) {
      if (pending.sessionId !== sessionId) continue;
      clearTimeout(pending.timer);
      this.pending.delete(commandId);
      pending.reject(new Error(`Remote backend session disposed: ${sessionId}`));
    }
    for (const [commandId, completion] of this.completions) {
      if (completion.sessionId !== sessionId) continue;
      clearTimeout(completion.timer);
      this.completions.delete(commandId);
      completion.reject(new Error(`Remote backend session disposed: ${sessionId}`));
    }
    for (const [commandId, completed] of this.completed) {
      if (completed.sessionId === sessionId) this.completed.delete(commandId);
    }
  }

  execute(sessionId: string, command: RemoteBackendCommand): Promise<unknown> {
    const commandId = command.commandId || randomUUID();
    const normalized = command.commandId === commandId ? command : { ...command, commandId };
    const existing = this.pending.get(commandId);
    if (existing) {
      if (existing.sessionId === sessionId && existing.fingerprint === commandFingerprint(normalized)) return existing.promise;
      if (existing.sessionId === sessionId) return Promise.reject(new Error(`Remote backend command id was reused with a different payload: ${commandId}`));
      return Promise.reject(new Error(`Remote backend command id collision: ${commandId}`));
    }
    const settled = this.completed.get(commandId);
    if (settled) {
      if (settled.sessionId !== sessionId) return Promise.reject(new Error(`Remote backend command id collision: ${commandId}`));
      if (settled.fingerprint !== commandFingerprint(normalized)) return Promise.reject(new Error(`Remote backend command id was reused with a different payload: ${commandId}`));
      return settled.error ? Promise.reject(settled.error) : Promise.resolve(settled.result);
    }
    let timer: NodeJS.Timeout;
    let resolvePromise: (value: unknown) => void = () => undefined;
    let rejectPromise: (error: Error) => void = () => undefined;
    const promise = new Promise<unknown>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
      timer = setTimeout(() => {
        this.pending.delete(commandId);
        const error = new Error(`Remote backend command timed out: ${normalized.type}`);
        this.rejectCompletion(commandId, error);
        reject(error);
      }, 90_000);
      timer.unref?.();
    });
    this.pending.set(commandId, {
      sessionId,
      command: normalized,
      fingerprint: commandFingerprint(normalized),
      promise,
      resolve: resolvePromise,
      reject: rejectPromise,
      timer: timer!
    });
    if (isCompletionCommand(normalized)) this.createCompletion(sessionId, normalized);
    const binding = this.bindings.get(sessionId);
    if (!binding) {
      const pending = this.pending.get(commandId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(commandId);
        pending.reject(new Error(`Remote backend session is offline: ${sessionId}`));
        this.rejectCompletion(commandId, new Error(`Remote backend session is offline: ${sessionId}`));
      }
    } else {
      this.send(binding, normalized);
    }
    return promise;
  }

  resolve(sessionId: string, transportId: string, generation: string, commandId: string, result: unknown) {
    const binding = this.bindings.get(sessionId);
    const pending = this.pending.get(commandId);
    if (!binding || binding.transportId !== transportId || binding.generation !== generation || !pending || pending.sessionId !== sessionId) return false;
    clearTimeout(pending.timer);
    this.pending.delete(commandId);
    this.rememberCompleted(commandId, { sessionId, command: pending.command, fingerprint: pending.fingerprint, result });
    pending.resolve(result);
    return true;
  }

  reject(sessionId: string, transportId: string, generation: string, commandId: string, message: string) {
    const binding = this.bindings.get(sessionId);
    const pending = this.pending.get(commandId);
    if (!binding || binding.transportId !== transportId || binding.generation !== generation || !pending || pending.sessionId !== sessionId) return false;
    clearTimeout(pending.timer);
    this.pending.delete(commandId);
    const error = new Error(message);
    this.rememberCompleted(commandId, { sessionId, command: pending.command, fingerprint: pending.fingerprint, error });
    this.rejectCompletion(commandId, error);
    pending.reject(error);
    return true;
  }

  waitForCompletion(sessionId: string, commandId: string) {
    const completion = this.completions.get(commandId);
    if (completion && completion.sessionId === sessionId) return completion.promise;
    const settled = this.completed.get(commandId);
    if (settled?.sessionId === sessionId && settled.completionError) return Promise.reject(settled.completionError);
    return Promise.resolve();
  }

  complete(sessionId: string, transportId: string, generation: string, commandId: string, message?: string) {
    const binding = this.bindings.get(sessionId);
    const completion = this.completions.get(commandId);
    if (!binding || binding.transportId !== transportId || binding.generation !== generation || !completion || completion.sessionId !== sessionId) return false;
    this.settleCompletion(commandId, message ? new Error(message) : undefined);
    return true;
  }

  private createCompletion(sessionId: string, command: RemoteBackendCommand) {
    let resolveCompletion: () => void = () => undefined;
    let rejectCompletion: (error: Error) => void = () => undefined;
    const promise = new Promise<void>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    const timer = setTimeout(() => {
      this.settleCompletion(command.commandId, new Error(`Remote backend command completion timed out: ${command.type}`));
    }, 90_000);
    timer.unref?.();
    this.completions.set(command.commandId, {
      sessionId,
      command,
      fingerprint: commandFingerprint(command),
      promise,
      resolve: resolveCompletion,
      reject: rejectCompletion,
      timer
    });
  }

  private rejectCompletion(commandId: string, error: Error) {
    const completion = this.completions.get(commandId);
    if (!completion) return;
    this.settleCompletion(commandId, error);
  }

  private settleCompletion(commandId: string, error?: Error) {
    const completion = this.completions.get(commandId);
    if (!completion) return;
    clearTimeout(completion.timer);
    this.completions.delete(commandId);
    const settled = this.completed.get(commandId);
    if (settled) settled.completionError = error;
    if (error) completion.reject(error);
    else completion.resolve();
  }

  private rememberCompleted(commandId: string, value: Completed) {
    this.completed.set(commandId, value);
    while (this.completed.size > 500) {
      const evict = [...this.completed.keys()].find((candidate) => !this.completions.has(candidate));
      if (!evict) return;
      this.completed.delete(evict);
    }
  }

  private send(binding: Binding, command: RemoteBackendCommand) {
    binding.send({
      type: "backend_command",
      protocolVersion: 1,
      sessionId: binding.sessionId,
      commandId: command.commandId,
      generation: binding.generation,
      command
    });
  }
}

const isCompletionCommand = (command: RemoteBackendCommand) => command.type === "turn" || command.type === "steer";
const commandFingerprint = (command: RemoteBackendCommand) => JSON.stringify(command);
