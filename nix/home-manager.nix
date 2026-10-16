self:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.vane;
  toml = pkgs.formats.toml { };
  configFile = toml.generate "vane-config.toml" cfg.settings;
in
{
  options.services.vane = {
    enable = lib.mkEnableOption "vane";
    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      description = "vane package.";
    };
    settings = lib.mkOption {
      inherit (toml) type;
      default = { };
      description = "TOML configuration. Use environment placeholders for secrets, never literal secrets.";
    };
    environmentFile = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "Runtime EnvironmentFile containing platform and model credentials.";
    };
    extraPackages = lib.mkOption {
      type = lib.types.listOf lib.types.package;
      default = [ ];
      description = "Optional additional host tools.";
    };
  };
  config = lib.mkIf cfg.enable {
    home.packages = [ cfg.package ];
    xdg.configFile."vane/config.toml".source = configFile;
    systemd.user.services.vane = {
      Unit = {
        Description = "vane";
        After = [
          "network-online.target"
          "graphical-session.target"
        ];
        Wants = [ "network-online.target" ];
        PartOf = [ "graphical-session.target" ];
      };
      Service = {
        ExecStart = lib.getExe cfg.package;
        WorkingDirectory = config.home.homeDirectory;
        Environment = [
          "PATH=${lib.makeBinPath cfg.extraPackages}:/run/current-system/sw/bin:${config.home.profileDirectory}/bin"
          "VANE_CONFIG=${configFile}"
        ];
        Restart = "on-failure";
        RestartSec = 5;
        TimeoutStopSec = 90;
        UMask = "0077";
      }
      // lib.optionalAttrs (cfg.environmentFile != null) {
        EnvironmentFile = cfg.environmentFile;
      };
      Install.WantedBy = [ "graphical-session.target" ];
    };
  };
}
