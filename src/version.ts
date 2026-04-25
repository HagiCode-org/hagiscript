export const packageName = "@hagicode/hagiscript";
export const packageVersion = "0.1.0";

export interface PackageMetadata {
  name: string;
  version: string;
}

export function getPackageMetadata(): PackageMetadata {
  return {
    name: packageName,
    version: packageVersion
  };
}
