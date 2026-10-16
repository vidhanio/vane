{
  lib,
  bun,
  bun2nix,
  makeWrapper,
  herdr,
}:
bun2nix.mkDerivation {
  packageJson = ../package.json;
  module = "src/cli.ts";
  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../src
      ../package.json
      ../bun.lock
      ../tsconfig.json
      ../bunfig.toml
    ];
  };
  nativeBuildInputs = [
    bun
    makeWrapper
  ];
  bunDeps = bun2nix.fetchBunDeps {
    bunNix = ./bun.nix;
  };
  doCheck = true;
  checkPhase = ''
    runHook preCheck
    bun run check
    bun run lint
    runHook postCheck
  '';
  postInstall = ''
    wrapProgram "$out/bin/vane" \
      --prefix PATH : ${lib.makeBinPath [ herdr ]}
  '';
  meta = {
    description = "vane";
    platforms = lib.platforms.linux;
  };
}
