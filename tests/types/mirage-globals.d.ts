/**
 * The app has no module system: every file is an IIFE that hangs itself off
 * `window`, so from any one file its siblings are undeclared globals. Declaring
 * them as `any` is not a shrug — it is the boundary of this checker. We are not
 * type-checking the whole app; we are checking that the turn contract is spelled
 * consistently where it is defined and where it is read.
 *
 * A sibling earns a real type by being typed itself, and then this line goes.
 */
declare var EngineState: any;
declare var MirageCalendar: any;
declare var MirageCommands: any;
declare var MirageImmersion: any;
declare var MirageLoyaltyUX: any;
declare var MirageMemoryLedger: any;
declare var MirageModels: any;
declare var MiragePhoneUX: any;
declare var MirageRoutine: any;
declare var MirageUserProfiles: any;
