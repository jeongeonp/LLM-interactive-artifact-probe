// Coding rounds: which artifacts each round double-codes (keys = pid__cond__task__seq).
// Round 2 (drawn 2026-10-27, seed 20261027): 10% of each task group, from artifacts not already
// coded by two people in round 1 — assigned tasks (relocation + study tools, 100 artifacts) → 10,
// user choice (77) → 8. Half interactive, half static; at most one artifact per participant.
const ROUNDS = {
  2: [
    "I3__interactive__relocation__2",
    "I7__interactive__studytool__1",
    "I8__interactive__studytool__1",
    "I14__interactive__relocation__1",
    "I17__interactive__studytool__1",
    "S1__static__studytool__1",
    "S10__static__relocation__3",
    "S11__static__relocation__4",
    "S12__static__studytool__1",
    "S14__static__studytool__2",
    "I6__interactive__userchoice__2",
    "I7__interactive__userchoice__1",
    "I14__interactive__userchoice__1",
    "I17__interactive__userchoice__4",
    "S3__static__userchoice__3",
    "S6__static__userchoice__2",
    "S7__static__userchoice__3",
    "S13__static__userchoice__1",
  ],
};
