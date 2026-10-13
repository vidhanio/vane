self:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.vidhan-bot;
  toml = pkgs.formats.toml { };
  configFile = toml.generate "vidhan-bot-config.toml" cfg.settings;
in
{
  options.services.vidhan-bot = {
    enable = lib.mkEnableOption "vidhan-bot";
    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      description = "vidhan-bot package.";
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
      default = [
        pkgs.git
        pkgs.bash
        pkgs.coreutils
        pkgs.direnv
        pkgs.nix
      ];
      description = "Optional additional host tools. Herdr is included in the bot package.";
    };
  };
  config = lib.mkIf cfg.enable {
    home.packages = [ cfg.package ];
    xdg.configFile."vidhan-bot/config.toml".source = configFile;
    systemd.user.services.vidhan-bot = {
      Unit = {
        Description = "vidhan-bot";
        After = [
          "network-online.target"
          "graphical-session.target"
        ];
        Wants = [ "network-online.target" ];
        PartOf = [ "graphical-session.target" ];
      };
      Service = {
        ExecStart = "${lib.getExe cfg.package} --config ${configFile}";
        WorkingDirectory = config.home.homeDirectory;
        Environment = "PATH=${lib.makeBinPath cfg.extraPackages}:/run/current-system/sw/bin:${config.home.profileDirectory}/bin";
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
