#!/usr/bin/env sh

# Run the main application (dist/index.js) with node, passing any arguments to it.
# The "exec" command replaces the current shell process with the node process, which is more efficient.
exec node dist/index.js "$@"