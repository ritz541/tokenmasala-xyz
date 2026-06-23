async function packageVersionIsPublished(packageName: string, version: string): Promise<boolean> {
  try {
    const response = await fetch(npmRegistryPackageVersionUrl(packageName, version), {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function npmRegistryPackageVersionUrl(packageName: string, version: string): string {
  return `https://registry.npmjs.org/${packageName.replace("/", "%2F")}/${encodeURIComponent(version)}`;
}

export { npmRegistryPackageVersionUrl, packageVersionIsPublished };
