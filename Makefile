#
# Copyright (c) 2014, Joyent, Inc. All rights reserved.
#
# Makefile: top-level Makefile
#
# This Makefile contains only repo-specific logic and uses included makefiles
# to supply common targets (javascriptlint, jsstyle, restdown, etc.), which are
# used by other repos as well.
#

#
# Tools must be installed on the path
#
JSL		 = jsl
JSSTYLE		 = jsstyle

#
# Files
#
JSON_FILES	 = package.json
JS_FILES	:= $(shell find lib schema -name '*.js')
JS_FILES	+= bin/dn \
		   tools/validate-schema
JSL_FILES_NODE   = $(JS_FILES)
JSSTYLE_FILES	 = $(JS_FILES)
JSL_CONF_NODE	 = tools/jsl.node.conf

all:
	npm install

test:
	@echo tests ok

include ./Makefile.targ