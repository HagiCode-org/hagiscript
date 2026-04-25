export {
  getPackageMetadata,
  packageName,
  packageVersion,
  type PackageMetadata
} from "./version.js";

export interface HagiscriptRuntimeInfo {
  packageName: string;
  version: string;
  status: "foundation";
}

export function createRuntimeInfo(): HagiscriptRuntimeInfo {
  return {
    packageName: "hagiscript",
    version: "0.1.0",
    status: "foundation"
  };
}
