import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merge conditional classes without letting a caller's override lose to a variant. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
