{
  description = "vidhan-bot: durable agent with pluggable platforms";

  inputs = {
    flake-parts = {
      url = "github:hercules-ci/flake-parts";
      inputs.nixpkgs-lib.follows = "nixpkgs";
    };
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    systems.url = "github:nix-systems/default-linux";
    bun2nix = {
      url = "github:Mic92/bun2nix/0456acb1b7394fc14c414b056aa889df5124943a";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.systems.follows = "systems";
    };
    treefmt-nix = {
      url = "github:numtide/treefmt-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    inputs:
    inputs.flake-parts.lib.mkFlake { inherit inputs; } {
      imports = [ inputs.treefmt-nix.flakeModule ];
      systems = import inputs.systems;
      flake.homeManagerModules.default = import ./nix/home-manager.nix inputs.self;

      perSystem =
        {
          system,
          pkgs,
          config,
          ...
        }:
        {
          _module.args.pkgs = import inputs.nixpkgs {
            inherit system;
            overlays = [ inputs.bun2nix.overlays.default ];
          };
          packages.default = pkgs.callPackage ./nix/package.nix { };
          apps.default = {
            type = "app";
            program = pkgs.lib.getExe config.packages.default;
          };
          checks.vidhan-bot = config.packages.default;
          treefmt = import ./nix/treefmt.nix { };
          devShells.default = pkgs.mkShell {
            packages = [
              pkgs.bun
              pkgs.bun2nix
              pkgs.oxfmt
              pkgs.oxlint
              pkgs.git
              pkgs.direnv
              pkgs.herdr
              config.treefmt.build.wrapper
            ];
            shellHook = ''
              bun install --frozen-lockfile
            '';
          };
        };
    };
}
