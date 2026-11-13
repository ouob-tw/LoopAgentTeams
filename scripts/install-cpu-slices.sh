#!/bin/sh
# Create or update the user-level lat-tests.slice and raise lat-board.service's CPUWeight.
# Safe to rerun. `--remove` deletes both. Values live in ~/.config/lat-cpu/slices.conf.
set -eu

config_home=${XDG_CONFIG_HOME:-$HOME/.config}
conf=${LAT_CPU_CONF:-$config_home/lat-cpu/slices.conf}
unit_dir=$config_home/systemd/user
slice_file=$unit_dir/lat-tests.slice
board_dropin=$unit_dir/lat-board.service.d/cpu-weight.conf

# Defaults; the conf file (sh syntax, KEY=value) overrides them.
TESTS_CPU_WEIGHT=30
TESTS_CPU_QUOTA=2000%
BOARD_CPU_WEIGHT=500

reload() { systemctl --user daemon-reload; }

if [ "${1:-}" = "--remove" ]; then
  rm -f "$slice_file" "$board_dropin"
  rmdir "$unit_dir/lat-board.service.d" 2>/dev/null || true
  reload
  echo "removed lat-tests.slice and the lat-board CPUWeight drop-in (config file $conf kept)"
  exit 0
fi

if [ -f "$conf" ]; then
  # shellcheck disable=SC1090
  . "$conf"
else
  mkdir -p "$(dirname "$conf")"
  cat > "$conf" <<CONF
# Read by scripts/install-cpu-slices.sh; edit, then rerun the script.
TESTS_CPU_WEIGHT=$TESTS_CPU_WEIGHT
TESTS_CPU_QUOTA=$TESTS_CPU_QUOTA
BOARD_CPU_WEIGHT=$BOARD_CPU_WEIGHT
CONF
fi

mkdir -p "$unit_dir" "$(dirname "$board_dropin")"
cat > "$slice_file" <<UNIT
[Unit]
Description=LAT test runs (CPU capped)

[Slice]
CPUWeight=$TESTS_CPU_WEIGHT
CPUQuota=$TESTS_CPU_QUOTA
UNIT
cat > "$board_dropin" <<UNIT
[Service]
CPUWeight=$BOARD_CPU_WEIGHT
UNIT
reload
echo "lat-tests.slice: CPUWeight=$TESTS_CPU_WEIGHT CPUQuota=$TESTS_CPU_QUOTA; lat-board.service: CPUWeight=$BOARD_CPU_WEIGHT"
