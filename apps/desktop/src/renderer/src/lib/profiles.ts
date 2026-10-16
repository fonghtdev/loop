import { createProfiles } from "./identity";

/** Everyone's display name, avatar and banner (lib/identity), seeded from every payload that carries them. A module of its own so pure UI parts can read it without pulling in the whole app. */
export const profiles = createProfiles();
