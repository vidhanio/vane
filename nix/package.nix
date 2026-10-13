{
  lib,
  stdenv,
  bun,
  bun2nix,
  makeWrapper,
  oxlint,
  herdr,
  ...
}:
stdenv.mkDerivation {
  pname = "vidhan-bot";
  version = "0.1.0";
  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../src
      ../package.json
      ../bun.lock
      ../tsconfig.json
      ../.oxlintrc.json
    ];
  };
  nativeBuildInputs = [
    bun
    bun2nix.hook
    makeWrapper
    oxlint
  ];
  bunDeps = bun2nix.fetchBunDeps {
    bunNix = ../bun.nix;
  };
  bunInstallFlags = [
    "--frozen-lockfile"
    "--linker=hoisted"
  ];
  dontRunLifecycleScripts = true;
  dontUseBunCheck = true;
  buildPhase = ''
    runHook preBuild
    bun run build
    runHook postBuild
  '';
  doCheck = true;
  checkPhase = ''
    runHook preCheck
    bun run check
    ${lib.getExe oxlint} --deny-warnings src
    runHook postCheck
  '';
  installPhase = ''
    runHook preInstall
    mkdir -p $out/lib/vidhan-bot $out/bin
    cp -r node_modules dist package.json $out/lib/vidhan-bot/
    makeWrapper ${bun}/bin/bun $out/bin/vidhan-bot \
      --add-flags "$out/lib/vidhan-bot/dist/cli.js" \
      --prefix PATH : ${lib.makeBinPath [ herdr ]}
    runHook postInstall
  '';
  meta = {
    description = "vidhan-bot";
    mainProgram = "vidhan-bot";
    platforms = lib.platforms.linux;
  };
}
