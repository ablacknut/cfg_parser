'use strict';

function setNode(obj, node) {
	if (node) {
		obj.node = node;
	} else {
		obj.node = null;
	}
}

function Closure(
	name,
	variables,
	args,
	closures,
	entry,
	exit,
	raise,
	blocks,
	strict,
	node,
	parentclosure,
	parentblockid
) {
	this.type = 'Closure';
	this.name = name;   //跟是Root，匿名函数是Anonymous[number]
	this.variables = variables;
	this.arguments = args;
	this.closures = closures;
	this.entry = entry;
	this.exit = exit;
	this.raise = raise;
	this.blocks = blocks;
	this.strict = strict;
	this.parentclosure = parentclosure;
	this.parentblockid = parentblockid;
	setNode(this, node);
}
exports.Closure = Closure;

function Variable(id, nodes) {
	this.type = 'Variable';
	this.id = id;
	this.nodes = nodes;
}
exports.Variable = Variable;

function VariableId(id, node) {
	this.type = 'VariableId';
	this.id = id;
	setNode(this, node);
}
exports.VariableId = VariableId;

function Literal(value, node) {
	this.type = 'Literal';
	this.value = value;
	setNode(this, node);
}
exports.Literal = Literal;

function Block(id, body, terminator) {
	this.type = 'Block';
	this.id = id;
	this.body = body;
	this.exception = []
	this.terminator = terminator;
}
exports.Block = Block;

function JumpTerminator(next, node) {
	this.type = 'JumpTerminator';
	this.next = next;
	setNode(this, node);
}
exports.JumpTerminator = JumpTerminator;

function IfTerminator(predicate, consequent, alternate, node) {
	this.type = 'IfTerminator';
	this.predicate = predicate;
	this.consequent = consequent;
	this.alternate = alternate;
	setNode(this, node);
}
exports.IfTerminator = IfTerminator;

function ReturnTerminator(result, node) {
	this.type = 'ReturnTerminator';
	this.result = result;
	setNode(this, node);
}
exports.ReturnTerminator = ReturnTerminator;

function ThrowTerminator(exception, node) {
	this.type = 'ThrowTerminator';
	this.exception = exception;
	setNode(this, node);
}
exports.ThrowTerminator = ThrowTerminator;
