#!/usr/bin/env bash

# Find the path from which this script runs, resolving any symbolic links to get the actual directory.
SOURCE="${BASH_SOURCE[0]}"
while [ -h "$SOURCE" ]; do
  DIR="$( cd -P "$( dirname "$SOURCE" )" >/dev/null 2>&1 && pwd )"
  SOURCE="$(readlink "$SOURCE")"
  [[ $SOURCE != /* ]] && SOURCE="$DIR/$SOURCE"
done
DIR="$( cd -P "$( dirname "$SOURCE" )" >/dev/null 2>&1 && pwd )"

# Run the main application (dist/index.js) with node, passing any arguments to it.
# The "exec" command replaces the current shell process with the node process, which is more efficient.
exec node $DIR/../dist/index.js "$@"