/**
 * The real-world airport subscription fixture lives OUTSIDE this repository:
 * it is a sample committed in the GoProxy repository and the original
 * author kept a copy in a machine-local temp directory. Tests that need it
 * therefore only run where that copy exists.
 *
 * Point GOPROXY_SUB_FIXTURE at a copy to exercise them; everywhere else
 * they are skipped (reported as skipped, not failed) so CI on Linux/macOS
 * stays green without pretending the fixture was verified.
 */
import { existsSync } from 'node:fs'

/** Path of the GoProxy Clash sample used by the fixture tests. */
export const SUB_FIXTURE = process.env.GOPROXY_SUB_FIXTURE
  ?? 'C:/Users/FishBottle/AppData/Local/Temp/GoProxy/subscriptions/sub_1775301718713.yaml'

/** True when the fixture is present on this machine. */
export const subFixtureAvailable = existsSync(SUB_FIXTURE)

/** `skip` option for node:test: false when the fixture exists, else why not. */
export const subFixtureSkip = subFixtureAvailable
  ? false
  : `fixture not available: ${SUB_FIXTURE} (set GOPROXY_SUB_FIXTURE to run this test)`
