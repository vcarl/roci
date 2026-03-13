# Fish completions for roci CLI
# Source this file, or symlink to ~/.config/fish/conf.d/roci.fish

# Wrapper function so `roci` works from anywhere in the project
function roci --wraps roci -d "Rocinante crew orchestrator"
    # Find project root by walking up to find the roci script
    set -l dir (pwd)
    while test "$dir" != "/"
        if test -x "$dir/roci"
            exec "$dir/roci" $argv
        end
        set dir (path dirname $dir)
    end
    echo "roci: not in a roci-crew project" >&2
    return 1
end

# Subcommands
set -l __roci_commands setup init start stop pause resume status auth logs destroy ws-test

# Disable file completions
complete -c roci -f

# Subcommand completions (only when no subcommand yet)
complete -c roci -n "not __fish_seen_subcommand_from $__roci_commands" -a setup -d "Set up character(s) for a domain"
complete -c roci -n "not __fish_seen_subcommand_from $__roci_commands" -a init -d "Initialize a domain — validate config"
complete -c roci -n "not __fish_seen_subcommand_from $__roci_commands" -a start -d "Start character(s)"
complete -c roci -n "not __fish_seen_subcommand_from $__roci_commands" -a stop -d "Stop a character"
complete -c roci -n "not __fish_seen_subcommand_from $__roci_commands" -a pause -d "Pause a character"
complete -c roci -n "not __fish_seen_subcommand_from $__roci_commands" -a resume -d "Resume a character"
complete -c roci -n "not __fish_seen_subcommand_from $__roci_commands" -a status -d "Show all container status"
complete -c roci -n "not __fish_seen_subcommand_from $__roci_commands" -a auth -d "Authenticate Claude in container"
complete -c roci -n "not __fish_seen_subcommand_from $__roci_commands" -a logs -d "Show recent thoughts"
complete -c roci -n "not __fish_seen_subcommand_from $__roci_commands" -a destroy -d "Remove container entirely"
complete -c roci -n "not __fish_seen_subcommand_from $__roci_commands" -a ws-test -d "Bare WebSocket connectivity test"

# Character name completions (dynamically from players/ directory)
function __roci_characters
    for dir in ./players ../players
        if test -d $dir
            for char in $dir/*/me
                basename (path dirname $char)
            end
            return
        end
    end
end

# Domain name completions
function __roci_domains
    echo spacemolt
    echo github
end

# Character completions for commands that take character arguments
complete -c roci -n "__fish_seen_subcommand_from setup start" -a "(__roci_characters)"
complete -c roci -n "__fish_seen_subcommand_from logs ws-test" -a "(__roci_characters)"

# --domain option for commands that use it
complete -c roci -n "__fish_seen_subcommand_from setup init" -l domain -d "Domain name" -ra "(__roci_domains)"
complete -c roci -n "__fish_seen_subcommand_from start" -l domain -d "Domain(s) to run" -ra "(__roci_domains)"
complete -c roci -n "__fish_seen_subcommand_from stop pause resume destroy" -l domain -d "Domain to target" -ra "(__roci_domains)"

# Options for start
complete -c roci -n "__fish_seen_subcommand_from start" -l tick-interval -d "Seconds between ticks" -r
complete -c roci -n "__fish_seen_subcommand_from start" -l manual-approval -d "Pause for manual approval before each step"
