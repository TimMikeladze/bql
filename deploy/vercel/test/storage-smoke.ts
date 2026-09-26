import { BlobObjectStore } from "../blob-store.ts"
import { qualifyStorage } from "../../shared/storage-contract.ts"

if (process.env.BQL_BILLABLE_TESTS !== "1") throw new Error("Set BQL_BILLABLE_TESTS=1 to opt into real storage writes")
const token = process.env.BLOB_READ_WRITE_TOKEN
const prefix = process.env.BQL_TEST_PREFIX
if (!token || !prefix) throw new Error("BLOB_READ_WRITE_TOKEN and disposable BQL_TEST_PREFIX are required")
if (process.env.VERCEL_BLOB_RETRIES !== "0") throw new Error("VERCEL_BLOB_RETRIES=0 is required for unambiguous CAS failures")
console.log(JSON.stringify({ sdk: "@vercel/blob@2.7.0", ...await qualifyStorage(new BlobObjectStore(token), prefix) }, null, 2))
