#!/bin/bash

# Temporarily (de)ignore Makefiles generated by CMake to allow easier
# git development

IGNORE=""

# Parse arguments
#
until [ -z "$1" ]
do
  case "$1" in
    -u|--undo)
      IGNORE="0"
      ;;
    -v|--verbose)
      # Be verbose
      VERBOSE="1"
      ;;
    -h|--help)
      # print help
      echo "Usage: $0"
      echo -e "  -h|--help\t\tPrint this help."
      echo -e "  -u|--undo\t\tRemove ignores and continue tracking."
      echo -e "  -v|--verbose\t\tVerbose."
      exit 1
      ;;
    *)
      # print error
      echo "Unknown argument: '$1'"
      exit 1
      ;;
  esac
  shift
done

if [ "X" = "X$IGNORE" ];
then
  [ ${VERBOSE} ] && echo "Ignoring Makefiles"
  git update-index --assume-unchanged Makefile library/Makefile programs/Makefile tests/Makefile
else
  [ ${VERBOSE} ] && echo "Tracking Makefiles"
  git update-index --no-assume-unchanged Makefile library/Makefile programs/Makefile tests/Makefile
fi
