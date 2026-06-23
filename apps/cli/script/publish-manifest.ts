import packageJson from "../package.json";
import { serviceRunnerOptionalDependencies } from "../src/service-runner-targets";

function createMainPackageJson() {
  return {
    name: packageJson.name,
    version: packageJson.version,
    description: packageJson.description,
    keywords: packageJson.keywords,
    license: packageJson.license,
    repository: packageJson.repository,
    bin: {
      tokenmaxxing: "./bin/tokenmaxxing.exe",
    },
    scripts: {
      postinstall: "node ./postinstall.mjs",
    },
    files: ["bin", "postinstall.mjs", "README.md", "LICENSE"],
    os: ["darwin", "linux", "win32"],
    cpu: ["arm64", "x64"],
    publishConfig: packageJson.publishConfig,
    optionalDependencies: serviceRunnerOptionalDependencies(packageJson.version),
  };
}

export { createMainPackageJson };
