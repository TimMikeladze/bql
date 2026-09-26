import { S3ObjectStore } from "../../../packages/db/src/storage/s3-object-store.ts"
import { qualifyStorage } from "../../shared/storage-contract.ts"

if (process.env.BQL_BILLABLE_TESTS !== "1") throw new Error("Set BQL_BILLABLE_TESTS=1 to opt into real storage writes")
const required = (name: string) => { const value = process.env[name]; if (!value) throw new Error(`Missing ${name}`); return value }
const store = new S3ObjectStore({ bucket: required("S3_BUCKET"), endpoint: required("S3_ENDPOINT"), region: process.env.S3_REGION ?? "auto", accessKeyId: required("S3_ACCESS_KEY_ID"), secretAccessKey: required("S3_SECRET_ACCESS_KEY") })
console.log(JSON.stringify(await qualifyStorage(store, required("BQL_TEST_PREFIX")), null, 2))
