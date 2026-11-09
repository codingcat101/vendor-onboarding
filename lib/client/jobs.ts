"use client";
import type { DocSlot, Submission } from "@/lib/engine/types";
import type { Upload } from "./pipeline";
import type { CaseRun } from "./store";

/** A submission handed from the vendor form to the case page, which runs it live. In-memory only. */
export interface Job {
  sub: Submission;
  uploads: Partial<Record<DocSlot, Upload>>;
  trigger: CaseRun["trigger"];
}
export const pendingJobs = new Map<string, Job>();
