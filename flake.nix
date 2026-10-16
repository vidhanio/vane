{
  description = "vane: durable agent with pluggable DM integrations";

  inputs = {
    flake-parts = {
      url = "github:hercules-ci/flake-parts";
      inputs.nixpkgs-lib.follows = "nixpkgs";
    };
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    systems.url = "github:nix-systems/default-linux";
    bun2nix = {
      url = "github:Mic92/bun2nix/lockfile-v2-v3";
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
            overlays = [
              inputs.bun2nix.overlays.default
              (final: prev: {
                bun = prev.bun.overrideAttrs {
                  version = "1.4.4-canary-5f5799e";
                  src = final.fetchurl {
                    url = "https://github.com/oven-sh/bun/releases/download/canary/bun-${
                      {
                        x86_64-linux = "linux-x64-baseline";
                        aarch64-linux = "linux-aarch64";
                        aarch64-darwin = "darwin-aarch64";
                      }
                      .${system}
                    }.zip";
                    hash =
                      {
                        x86_64-linux = "sha256-gK+A7VaGAPTKZbRKD/twJYaXOh8O/gZy1WK+QB8pVig=";
                        aarch64-linux = "sha256-FUtFYaqZzUqP3nBjV5G3pxEykw0jdXX4MIkVqySeHLA=";
                        aarch64-darwin = "sha256-LL40rGK6r5ezk13YJkgJRw8/fQqNm9atRwdimHjRdUE=";
                      }
                      .${system};
                  };
                };
              })
            ];
          };
          packages.default = pkgs.callPackage ./nix/package.nix { };
          checks.vane = config.packages.default;
          treefmt = {
            projectRootFile = "flake.nix";
            settings.formatter.bun = {
              command = "${pkgs.bun}/bin/bun";
              options = [ "fmt" ];
              includes = [
                "*.ts"
                "*.json"
                "*.yml"
                "*.yaml"
                "*.md"
              ];
              excludes = [
                "README.md"
                "bun.lock"
                "flake.lock"
              ];
            };
            programs.nixfmt.enable = true;
            programs.taplo.enable = true;
            settings.global.excludes = [
              "nix/bun.nix"
              "node_modules/**"
              "dist/**"
              ".direnv/**"
              "result/**"
            ];
          };
          devShells.default = pkgs.mkShell {
            packages = [
              pkgs.bun
              pkgs.bun2nix
              pkgs.git
              pkgs.direnv
              config.treefmt.build.wrapper
            ];
            shellHook = ''
              bun install --frozen-lockfile
            '';
          };
        };
    };
}
