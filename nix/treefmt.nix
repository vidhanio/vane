{ ... }:
{
  projectRootFile = "flake.nix";
  programs.oxfmt.enable = true;
  programs.nixfmt.enable = true;
  programs.taplo.enable = true;
  settings.formatter.oxfmt.excludes = [
    "bun.lock"
    "flake.lock"
  ];
  settings.global.excludes = [
    "bun.nix"
    "node_modules/**"
    "dist/**"
    ".direnv/**"
    "result/**"
  ];
}
