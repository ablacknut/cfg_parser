'use strict';

module.exports = analyzeClosure;
const estraverse = require('estraverse');
const { exec } = require('child_process');
var extractVariables = require('./get-vars');
var types = require('./types');

var Closure = types.Closure;
var Variable = types.Variable;
var VariableId = types.VariableId;
var Literal = types.Literal;
var Block = types.Block;
var JumpTerminator = types.JumpTerminator;
var IfTerminator = types.IfTerminator;
var ReturnTerminator = types.ReturnTerminator;
var ThrowTerminator = types.ThrowTerminator;
var func_tmp_counter = 0;

function analyzeClosure(node, environment, parentclosure, parentblockid) {
	var counter = 0;
	var name = 'Root';
	var vars = [];
	var clargs = [];
	var blocks = [];
	var strictMode = !!environment.strict;
	var returnValue, throwValue;
	var enter, exit, raise;

	function clone(variable) {
		if (variable.type === 'VariableId') {
			return new VariableId(variable.id, variable.node);
		} else if (variable.type === 'Literal') {
			return new Literal(variable.value, variable.node);
		}
	}

	function temporary(node) {
		var id = '~' + environment.temp.counter++;
		var v = new Variable(id, []);
		if (node) {
			v.nodes.push(node);
		}
		vars.push(v);
		return new VariableId(id, node);
	}

	function block(body, terminator, exception) {
		var n = blocks.length;
		var b = new Block(n, body, terminator);
		if (exception){
			b.exception.push(exception);
		}
		blocks.push(b);
		return n;
	}

	var node_sequence = [];
	estraverse.traverse(node, {
		enter(node) {
			// console.log('enter: ' + node.type);
			node_sequence.push(node.type);
		},
	});
	//Construct exit block
	returnValue = temporary(node).id;
	exit = block(
		[],
		new ReturnTerminator(new VariableId(returnValue, node), node) //是否应该用node节点
	);
	blocks[exit].body = node_sequence;

	//Construct throw block
	throwValue = temporary(node).id;
	raise = block(
		[],
		new ThrowTerminator(new VariableId(throwValue, node), node)
	);
	blocks[raise].body = node_sequence;

	//Handle root node type
	var body;
	vars.push(new Variable('this', []));
	if (node.type === 'Program') {
		body = node.body;
		vars.push(new Variable('~global', [node]));
	} else if (
		node.type === 'FunctionDeclaration' ||
		node.type === 'FunctionExpression' ||
		node.type === 'ArrowFunctionExpression'
	) {
		name = node.id
			? node.id.name
			: 'Anonymous' + String(func_tmp_counter++);
		for (var i = 0; i < node.params.length; ++i) {
			var v = new Variable(node.params[i].name, [node.params[i]]);
			vars.push(v);
			clargs.push(new VariableId(node.params[i].name, node.params[i]));
		}
		if (node.body.type == 'BlockStatement'){
			body = node.body.body;
		}else{
			body = {
				type: 'BlockStatement',
				body: node.body
			};
		}
	}  else if (node.type === 'MethodDefinition' ) {
		name = node.key.name;
		for (var i = 0; i < node.value.params.length; ++i) {
			var v = new Variable(node.value.params[i].name, [node.value.params[i]]);
			vars.push(v);
			clargs.push(new VariableId(node.value.params[i].name, node.value.params[i]));
		}
		body = node.value.body.body;
	}else {
		throw new Error('control-flow: Invalid node type for closure');
	}

	//Hoist all variable identifiers
	var varIds = extractVariables(body);
	for (var i = 0; i < varIds.length; ++i) {
		vars.push(new Variable(varIds[i], []));
	}

	//List of all pending closurers
	var pendingClosures = [];
	var firstStatement = true;
	function processBlock(body, env) {
		var cblock = blocks[block([], null)];
		for (var cenv = env; cenv; cenv = cenv.parent) {
			if (cenv.catch && (cblock.exception.indexOf(cenv.catch) == -1)) {
					cblock.exception.push(cenv.catch);
			}
		}
		var ops = cblock.body;
		var firstBlockId = cblock.id;

		if (!Array.isArray(body)) {
			body = [body];
		}

		var isFirst = firstStatement;
		firstStatement = false;
		if(isFirst){
			ops.push(node.type);
		}
		//For the first object, need to store global variable
		// if (env.first) {
		// 	env.first = false;
		// 	assign(
		// 		new VariableId('~global', body[0]),
		// 		new VariableId('this', body[0]),
		// 		body[0] //需要考虑是否更换
		// 	);
		// }

		//Retrieve an identifier
		function lookupIdentifier(name, node) {
			var v = new VariableId(name, node);
			if (name.charAt(0) === '~' || name === 'arguments') {
				return v;
			}
			for (var cenv = env; cenv; cenv = cenv.parent) {
				if (cenv.catchVar && cenv.catchVar[0] === name) {
					return new VariableId(cenv.catchVar[1], node);
				}
				for (var i = 0; i < cenv.vars.length; ++i) {
					if (cenv.vars[i].id === name) {
						if (node) {
							cenv.vars[i].nodes.push(node);
						}
						return clone(v);
					}
				}
			}
			return clone(v);
		}

		function makeEnv(opts) {
			var nenv = {};
			for (var id in env) {
				nenv[id] = env[id];
			}
			nenv.vars = [];
			nenv.label = null;
			nenv.withObject = null;
			nenv.isSwitch = false;
			nenv.catchVar = null;
			if (opts) {
				for (var id in opts) {
					nenv[id] = opts[id];
				}
			}
			nenv.parent = env;
			return nenv;
		}

		function splitBlock(terminator) {
			var nblock = blocks[block([], null)];
			for (var cenv = env; cenv; cenv = cenv.parent) {
				if (cenv.catch && (nblock.exception.indexOf(cenv.catch) == -1)) {
						nblock.exception.push(cenv.catch);
				}
			}
			cblock.terminator = terminator;
			ops = nblock.body;
			cblock = nblock;
		}


		function lookupLabel(label) {
			for (var cenv = env; cenv; cenv = cenv.parent) {
				if (cenv.label === label) {
					return cenv;
				}
			}
			throw new Error('control-flow: Label not found: ' + label);
		}

		function processExpression(node) {
			switch (node.type) {
				case 'ThisExpression':
					ops.push('ThisExpression');
					for (var i = 0; i < vars.length; ++i) {
						if (vars[i].id === 'this') {
							vars[i].nodes.push(node);
							break;
						}
					}
					return new VariableId('this', node);

				case 'MemberExpression':
					ops.push('MemberExpression');
					var o = processExpression(node.object);
					var r = temporary(node);
					var p = processExpression(node.property);
					return clone(r);

				case 'Identifier':
					ops.push('Identifier');
					return lookupIdentifier(node.name, node);

				case 'Literal':
					ops.push('Literal');
					return new Literal(node.value, node);

				case 'FunctionExpression': //为function单独分出一个块，terminater是jump
					var term1 = new JumpTerminator(0, node);
					splitBlock(term1);
					term1.next = cblock.id;

					ops.push('FunctionExpression');
					var r = temporary(node);
					pendingClosures.push({
						id: r,
						parentblockid: cblock.id,
						parentclosure: name,
						closure: node,
						environment: makeEnv({
							root: false,
						}),
					});
					var functerm = new JumpTerminator(0, node);
					splitBlock(functerm);
					functerm.next = cblock.id;
					return clone(r);

				case 'ArrowFunctionExpression':
					var term1 = new JumpTerminator(0, node);
					splitBlock(term1);
					term1.next = cblock.id;

					ops.push('ArrowFunctionExpression');
					var r = temporary(node);
					pendingClosures.push({
						id: r,
						parentblockid: cblock.id,
						parentclosure: name,
						closure: node,
						environment: makeEnv({
							root: false,
						}),
					});
					var functerm = new JumpTerminator(0, node);
					splitBlock(functerm);
					functerm.next = cblock.id;
					return clone(r);

				case 'SequenceExpression':
					ops.push('SequenceExpression');
					var r;
					for (var i = 0; i < node.expressions.length; ++i) {
						r = processExpression(node.expressions[i]);
					}
					return r;

				case 'UnaryExpression':
					ops.push('UnaryExpression');
					var r = temporary(node);
					var arg = processExpression(node.argument);
					return clone(r);

				case 'BinaryExpression':
					ops.push('BinaryExpression');
					var r = temporary(node);
					var a = processExpression(node.left);
					var b = processExpression(node.right);
					return clone(r);

				case 'AssignmentExpression':
					ops.push('AssignmentExpression');
					var a = processExpression(node.right);
					var tok = node.operator;
					var tmp = temporary(node);
					var b = processExpression(node.left);
					return clone(tmp);

				case 'UpdateExpression':
					ops.push('UpdateExpression');
					var tok;
					if (node.operator === '++') {
						tok = '+';
					} else if (node.operator === '--') {
						tok = '-';
					}
					var r = temporary(node);
					var v = processExpression(node.argument);
					if (node.prefix) {
						return clone(r);
					} else {
						return clone(v);
					}

				case 'LogicalExpression':
					ops.push('LogicalExpression');
					var tmp = temporary(node);
					var r = processExpression(node.left);
					var s = new IfTerminator(clone(r), 0, 0, node);
					var x = blocks.length;
					splitBlock(s);
					var l = processExpression(node.right);
					var y = blocks.length;
					var t = new JumpTerminator(y, node);
					splitBlock(t);
					if (node.operator === '||') {
						s.consequent = y;
						s.alternate = x;
					} else if (node.operator === '&&') {
						s.consequent = x;
						s.alternate = y;
					} else {
						throw new Error(
							'control-flow: Unrecognized logical operator'
						);
					}
					return clone(tmp);

				case 'ConditionalExpression':
					ops.push('ConditionalExpression');
					var r = temporary(node);
					var test = processExpression(node.test);
					var term1 = new IfTerminator(test, 0, 0, node);
					splitBlock(term1);
					term1.consequent = cblock.id;
					var t = processExpression(node.consequent);
					var term2 = new JumpTerminator(0, node);
					splitBlock(term2);
					term1.alternate = cblock.id;
					var f = processExpression(node.alternate);
					var term3 = new JumpTerminator(0, node);
					splitBlock(term3);
					term2.next = cblock.id;
					term3.next = cblock.id;
					return clone(r);

				case 'CallExpression':
					ops.push('CallExpression');
					var f = processExpression(node.callee);
					var args = new Array(node.arguments.length);
					for (var i = 0; i < node.arguments.length; ++i) {
						args[i] = processExpression(node.arguments[i]);
					}
					var r = temporary(node);
					return clone(r);

				case 'NewExpression':
					ops.push('NewExpression');
					var args = new Array(node.arguments.length);
					for (var i = 0; i < node.arguments.length; ++i) {
						args[i] = processExpression(node.arguments[i]);
					}
					var r = temporary(node);
					var ctor = processExpression(node.callee);
					return clone(r);

				case 'ArrayExpression':
					ops.push('ArrayExpression');
					var arr = temporary(node);
					for (var i = 0; i < node.elements.length; ++i) {
						var val;
						if (node.elements[i]) {
							val = processExpression(node.elements[i]);
						} else {
							ops.push('Literal');
							val = new Literal(undefined, node);
						}
					}
					return clone(arr);

				case 'SpreadElement':
					ops.push('SpreadElement');
					var tmp = processExpression(node.argument);
					return clone(tmp);

				case 'ObjectExpression':
					ops.push('ObjectExpression');
					var obj = temporary(node);
					for (var i = 0; i < node.properties.length; ++i) {
						ops.push('Property');
						var prop = node.properties[i];
						var p = processExpression(prop.key);
						var value = processExpression(prop.value);
					}
					return clone(obj);

				case 'TemplateLiteral':
					var obj = temporary(node);
					ops.push('TemplateLiteral');
					for (var i = 0; i < node.expressions.length; ++i) {
						var p = processExpression(node.expressions[i]);
					}
					return clone(obj);
				
				case 'ClassExpression':
					var obj = temporary(node);
					ops.push('ClassExpression');
					ops.push('ClassBody');
					var term1 = new JumpTerminator(0, node);
					splitBlock(term1);
					term1.next = cblock.id;
					for (let i = 0; i < node.body.body.length; i++) {
						let method = node.body.body[i];
						ops.push('MethodDefinition');
						pendingClosures.push({
							id: temporary(method),
							parentblockid: cblock.id,
							parentclosure: name,
							closure: method,
							environment: makeEnv({
								root: false,
							}),
						});
						var functerm = new JumpTerminator(0, node);
						splitBlock(functerm);
						functerm.next = cblock.id;
					}
					return clone(obj);
				
				case 'Super':
					var obj = temporary(node);
					ops.push('Super');
					return clone(obj);

				case 'ArrayPattern':
					var obj = temporary(node);
					ops.push('ArrayPattern');
					for (let i = 0; i < node.elements.length; i++) {
						let element = node.elements[i];
						processExpression(element);
					}
					return clone(obj);
				
				case 'ObjectPattern':
					ops.push('ObjectPattern');
					var obj = temporary(node);
					for (var i = 0; i < node.properties.length; ++i) {
						ops.push('Property');
						var prop = node.properties[i];
						var p = processExpression(prop.key);
						var value = processExpression(prop.value);
					}
					return clone(obj);

				case 'AwaitExpression':
					var obj = temporary(node);
					ops.push('AwaitExpression');
					processExpression(node.argument);
					return clone(obj);

				default:
					throw new Error(
						'control-flow: Unrecognized expression type: ' +
							node.type
					);
			}
		}

		function processStatement(stmt) {
			switch (stmt.type) {
				case 'EmptyStatement':
					ops.push('EmptyStatement');
					break;

				case 'BlockStatement':
					ops.push('BlockStatement');
					for (var i = 0; i < stmt.body.length; ++i) {
						processStatement(stmt.body[i]);
					}
					break;

				case 'ExpressionStatement':
					ops.push('ExpressionStatement');
					var r = processExpression(stmt.expression);
					//Check if we should enable strict mode
					if (
						isFirst &&
						r.type === 'Literal' &&
						r.value === 'use strict'
					) {
						strictMode = env.strict = true;
					}
					break;

				case 'IfStatement':
					ops.push('IfStatement');
					var test = processExpression(stmt.test);
					if ((stmt.consequent && stmt.consequent.type != 'BlockStatement' ) || (stmt.consequent.type == 'BlockStatement' && stmt.consequent.body.length)) {
						var term = new IfTerminator(test, 0, 0, stmt);
						splitBlock(term);
						var next = cblock.id;
						term.consequent = processBlock(
							stmt.consequent,
							makeEnv({
								next: next,
							})
						);
						if (stmt.alternate) {
							term.alternate = processBlock(
								stmt.alternate,
								makeEnv({
									next: next,
								})
							);
						} else {
							term.alternate = next;
						}
					}
					break;

				case 'LabeledStatement':
					var jmp = new JumpTerminator(0,stmt);
					splitBlock(jmp);
					ops.push('LabeledStatement');
					jmp = processBlock(stmt.body, makeEnv({
						next: cblock.id,
						breakBlock:  cblock.id,
						continueBlock: cblock.id + 1,
						label: stmt.label.name
					}));
					break;

				case 'BreakStatement':
					ops.push('BreakStatement');
					if (stmt.label) {
						var e = lookupLabel(stmt.label.name);
						splitBlock(new JumpTerminator(e.breakBlock, stmt));
					} else {
						splitBlock(new JumpTerminator(env.breakBlock, stmt));
					}
					break;

				case 'ContinueStatement':
					ops.push('ContinueStatement');
					if (stmt.label) {
						var e = lookupLabel(stmt.label.name);
						if (e.isSwitch) {
							throw new Error(
								"control-flow: Can't continue from switch statement"
							);
						}
						splitBlock(new JumpTerminator(e.continueBlock, stmt));
					} else {
						splitBlock(new JumpTerminator(env.continueBlock, stmt));
					}
					break;

				case 'WithStatement':
					ops.push('WithStatement');
					var obj = processExpression(stmt.object);
					var body = processStatement(stmt.body);
					break;

				case 'SwitchStatement':
					ops.push('SwitchStatement');
					var discr = processExpression(stmt.discriminant);
					var jmpToSwitchHead = new JumpTerminator(0, stmt);
					splitBlock(jmpToSwitchHead);

					var jmpToSwitchBreak = new JumpTerminator(0, stmt);
					var breakBlockId = blocks.length - 1;
					splitBlock(jmpToSwitchBreak);

                    jmpToSwitchHead.next = cblock.id;
					for (var i = 0; i < stmt.cases.length; ++i) {
						var c = stmt.cases[i];
						if (c.test) {
							ops.push('SwitchCase');
							//处理case语句
							var r = processExpression(c.test);
							if (c.consequent.length) {
								var casejmp = new IfTerminator(clone(r), 0, 0, c);
                                splitBlock(casejmp);
								casejmp.consequent = processBlock(
									c.consequent,
									makeEnv({
										next: cblock.id,
										breakBlock: breakBlockId,
										isSwitch: true,
									})
								);
                                casejmp.alternate = cblock.id;
							}
						} else {
							//处理default语句
							if (c.consequent.length) {
								var casejmp = new JumpTerminator(0, c);
								splitBlock(casejmp);
                                casejmp.next = processBlock(
                                    c.consequent,
                                    makeEnv({
                                        next: cblock.id,
                                        breakBlock: breakBlockId,
                                        isSwitch: true,
                                    })
                                )
								blocks[casejmp.next].body.splice(0,0,'SwitchCase');
							}else{
								ops.push('SwitchCase');
							}
						}
					}
					jmpToSwitchBreak.next = cblock.id;
					break;

				case 'ReturnStatement':
					ops.push('ReturnStatement');
					if(stmt.argument){
						processExpression(stmt.argument);
					}
					splitBlock(new JumpTerminator(exit, stmt));
					break;

				case 'ThrowStatement':
					ops.push('ThrowStatement');
                    processExpression(stmt.argument)
					splitBlock(new JumpTerminator(env.catch, stmt));
					break;

				case 'TryStatement':
					ops.push('TryStatement');
					var jmpToStart = new JumpTerminator(0, stmt);
                    splitBlock(jmpToStart);
                    //Generate finally block
					var next = cblock.id;
					var finallyBlock;
					if (stmt.finalizer) {
						finallyBlock = processBlock(
							stmt.finalizer,
							makeEnv({
								next: next,
							})
						);
					} else {
						finallyBlock = next;
					}

					//Get handler
					var handler = stmt.handler;
					if (!handler && stmt.handlers && stmt.handlers.length > 0) {
						handler = stmt.handlers[0];
					}

					//Generate catch block
					var catchBlock;
					var exception = temporary(stmt);
					if (handler) {
						catchBlock = processBlock(
							handler,
							makeEnv({
								next: finallyBlock,
								catchVar: [handler.param.name, exception.id],
							})
						);
					}

					//Generate main try block
					var tryBlock = processBlock(
						stmt.block,
						makeEnv({
							next: finallyBlock,
							exception: exception.id,
							catch: catchBlock || null,
						})
					);

					//Fix up links
					jmpToStart.next = tryBlock;
					break;
				
				case 'CatchClause':
					ops.push('CatchClause');
					processExpression(stmt.param);
					processStatement(stmt.body);
					break;

				case 'WhileStatement':
					ops.push('WhileStatement');
					var jmp = new JumpTerminator(0, stmt);
					splitBlock(jmp);
					var loopStart = cblock.id;
					jmp.next = loopStart;
					var test = processExpression(stmt.test);
					var ifHead = new IfTerminator(test, 0, 0, stmt);
					splitBlock(ifHead);
					var loopExit = cblock.id;
					var loopBody = processBlock(
						stmt.body,
						makeEnv({
							next: loopStart,
							continueBlock: loopStart,
							breakBlock: loopExit,
						})
					);
					ifHead.consequent = loopBody;
					ifHead.alternate = loopExit;
					break;

				case 'DoWhileStatement':
					ops.push('DoWhileStatement');
					var jmpStart = new JumpTerminator(0, stmt);
					splitBlock(jmpStart);
					var loopStart = cblock.id;
					var test = processExpression(stmt.test);
					var ifHead = new IfTerminator(test, 0, 0, node);
					splitBlock(ifHead);
					var loopExit = cblock.id;
					var loopBody = processBlock(
						stmt.body,
						makeEnv({
							next: loopStart,
							continueBlock: loopStart,
							breakBlock: loopExit,
						})
					);
					jmpStart.next = loopBody;
					ifHead.consequent = loopBody;
					ifHead.alternate = loopExit;
					break;

				case 'ForStatement':
					ops.push('ForStatement');
					//Create initialization block
					if (stmt.init) {
						if (stmt.init.type === 'VariableDeclaration') {
							processStatement(stmt.init);
						} else {
							processExpression(stmt.init);
						}
					}
					var jmpStart = new JumpTerminator(0, next);
					splitBlock(jmpStart);

					//Create test block
					var loopTest = cblock.id;
					var test;
					if (stmt.test) {
						test = processExpression(stmt.test);
						var ifTest = new IfTerminator(test, 0, 0, stmt.test || stmt);
						splitBlock(ifTest);
					} else {
						var jmp = new JumpTerminator(0, stmt.test || stmt);
						splitBlock(jmp);
					}

					//Create update block
					var loopUpdate = cblock.id;
					if (stmt.update) {
						processExpression(stmt.update);
					}
					var jmpUpdate = new JumpTerminator(
						loopTest,
						stmt.update || stmt
					);
					splitBlock(jmpUpdate);

					//Create exit node
					var loopExit = cblock.id;

					//Link nodes
					jmpStart.next = loopTest;
					if (stmt.test) {
						ifTest.alternate = loopExit;
						ifTest.consequent = processBlock(
							stmt.body,
							makeEnv({
								next: loopUpdate,
								continueBlock: loopUpdate,
								breakBlock: loopExit,
							})
						);
					} else {
						jmp.next = processBlock(
							stmt.body,
							makeEnv({
								next: loopUpdate,
								continueBlock: loopUpdate,
								breakBlock: loopExit,
							})
						);
					}
					
					break;

				case 'ForInStatement':
					ops.push('ForInStatement');
					var rightObj = processExpression(stmt.right);
					var jmp = new JumpTerminator(blocks.length, stmt);
					splitBlock(jmp)

					if (stmt.left.type == 'VariableDeclaration'){
						var leftObj = processStatement(stmt.left);
					}else{
						var leftObj = processExpression(stmt.left);
					}
					var loopStart = cblock.id;
					var ift = new IfTerminator(leftObj, 0, blocks.length, stmt);
					splitBlock(ift);
					var loopExit = cblock.id;

					var loopBody = processBlock(
						stmt.body,
						makeEnv({
							next: loopStart,
							breakBlock: loopExit,
							continueBlock: loopStart,
						})
					);
					ift.consequent = loopBody;
					break;

				case 'ForOfStatement':
					ops.push('ForOfStatement');
					var rightObj = processExpression(stmt.right);
					var jmp = new JumpTerminator(blocks.length, stmt);
					splitBlock(jmp)

					if (stmt.left.type == 'VariableDeclaration'){
						var leftObj = processStatement(stmt.left);
					}else{
						var leftObj = processExpression(stmt.left);
					}
					var loopStart = cblock.id;
					var ift = new IfTerminator(leftObj, 0, blocks.length, stmt);
					splitBlock(ift);
					var loopExit = cblock.id;

					var loopBody = processBlock(
						stmt.body,
						makeEnv({
							next: loopStart,
							breakBlock: loopExit,
							continueBlock: loopStart,
						})
					);
					ift.consequent = loopBody;
					break;

				case 'VariableDeclaration':
					ops.push('VariableDeclaration');
					for (var i = 0; i < stmt.declarations.length; ++i) {
						ops.push('VariableDeclarator');
						processExpression(stmt.declarations[i].id)
						if (stmt.declarations[i].init) {
                            processExpression(stmt.declarations[i].init);
						}
					}
					break;

				case 'FunctionDeclaration':
					var term1 = new JumpTerminator(0, stmt);
					splitBlock(term1);
					term1.next = cblock.id;

					ops.push('FunctionDeclaration');
					var tmp = temporary(stmt);
					pendingClosures.push({
						id: tmp,
						parentblockid: cblock.id,
						parentclosure: name,
						closure: stmt,
						environment: makeEnv({
							root: false,
						}),
					});
					var functerm = new JumpTerminator(0, stmt);
					splitBlock(functerm);
					functerm.next = cblock.id;
					break;
			
				case 'ClassDeclaration':
					ops.push('ClassDeclaration');
					ops.push('ClassBody');
					var term1 = new JumpTerminator(0, stmt);
					splitBlock(term1);
					term1.next = cblock.id;
					for (let i = 0; i < stmt.body.body.length; i++) {
						let method = stmt.body.body[i];
						ops.push('MethodDefinition');
						pendingClosures.push({
							id: temporary(method),
							parentblockid: cblock.id,
							parentclosure: name,
							closure: method,
							environment: makeEnv({
								root: false,
							}),
						});
						var functerm = new JumpTerminator(0, stmt);
						splitBlock(functerm);
						functerm.next = cblock.id;
					}
					break;

				case 'DebuggerStatement':
					ops.push('DebuggerStatement ');
					break;

				default:
					throw new Error(
						'control-flow: Unsupported statement type ' + stmt.type
					);
			}
		}
		for (var i = 0; i < body.length; ++i) {
			processStatement(body[i]);
		}
		cblock.terminator = new JumpTerminator(env.next, body[body.length - 1]);
		return firstBlockId;
	}
	enter = processBlock(body, {
		parent: environment.parent,
		vars: vars,
		next: exit,
		returnValue: returnValue,
		exit: exit,
		continueBlock: exit,
		breakBlock: exit,
		label: null,
		exception: throwValue,
		catch: raise,
		catchVar: null,
		root: node.type === 'Program',
		first: node.type === 'Program',
		withObject: null,
		strict: !!environment.strict,
		isSwitch: true,
		temp: environment.temp,
	});

	//去除所有body为空的块，和无前继节点的块
	//判断一个块是否有前继节点
	function hasPre(cblock){
		let id = cblock.id;
		let hasNoPre = true;
		for (let block of blocks){
			let terminator = block.terminator;
			if (block.exception.indexOf(id) != -1){
				hasNoPre = false;
				break;
			}
			if (terminator.type == 'JumpTerminator'){
				if (terminator.next == id){
					hasNoPre = false;
					break;
				}
			}else if (terminator.type == 'IfTerminator'){
				if ((terminator.consequent == id) || (terminator.alternate == id)){
					hasNoPre = false;
					break;
				}
			}
		}
		if(hasNoPre){
			return false;
		}else{
			return true;
		}
	}

	function delBlock(id){
		let rblock = blocks[id];
		blocks.splice(id, 1);
		for (let j = 0; j < pendingClosures.length; ++j){
			if (pendingClosures[j].parentblockid > id){
				pendingClosures[j].parentblockid = pendingClosures[j].parentblockid - 1;
			}
		}
		for(let i = 0; i < blocks.length; ++i){
			let block = blocks[i];
			if (i >= id){
				block.id = block.id - 1;
			}
			for (let j = 0; j < block.exception.length; ++j){
				if(block.exception[j] > id){
					block.exception[j] = block.exception[j] - 1;
				}else if (block.exception[j] == id){
					block.exception[j] = (rblock.terminator.next>id) ? rblock.terminator.next-1 : rblock.terminator.next;
				}
			}
			if (block.terminator.type == 'JumpTerminator'){
				if (block.terminator.next > id){
					block.terminator.next = block.terminator.next - 1;
				}else if (block.terminator.next == id){
					if (rblock.type == 'JumpTerminator'){
						block.terminator.next = (rblock.terminator.next>id) ? rblock.terminator.next-1 : rblock.terminator.next;
					}else if(rblock.terminator.type == 'IfTerminator'){
						block.terminator = new IfTerminator(
							rblock.terminator.predicate,
							(rblock.terminator.consequent>id) ? rblock.terminator.consequent - 1 : rblock.terminator.consequent,
							(rblock.terminator.alternate>id) ? rblock.terminator.alternate - 1 : rblock.terminator.alternate,
							rblock.terminator.node
						);					
					}
				}
			}else if (block.terminator.type == 'IfTerminator'){
				if (block.terminator.consequent > id){
					block.terminator.consequent = block.terminator.consequent - 1;
				}else if (block.terminator.consequent == id){
					if (rblock.type == 'JumpTerminator'){
						block.terminator.consequent = (rblock.terminator.next>id) ? rblock.terminator.next-1 : rblock.terminator.next;
					}else if(rblock.terminator.type == 'IfTerminator'){
						block.terminator.consequent = (rblock.terminator.consequent>id) ? rblock.terminator.consequent - 1 : rblock.terminator.consequent;
					}
				}
				if (block.terminator.alternate > id){
					block.terminator.alternate = block.terminator.alternate - 1;
				}else if (block.terminator.alternate == id){
					if (rblock.type == 'JumpTerminator'){
						block.terminator.alternate = (rblock.terminator.next>id) ? rblock.terminator.next-1 : rblock.terminator.next;
					}else if(rblock.terminator.type == 'IfTerminator'){
						block.terminator.alternate = (rblock.terminator.alternate>id) ? rblock.terminator.alternate - 1 : rblock.terminator.alternate;
					}
				}
			}
		}
	}

	//判断哪些block需要删除
	var needDelblocks = []
	for(let cblock of blocks){
		if ((cblock.id > 2) &&(!hasPre(cblock) || cblock.body.length == 0)){
			needDelblocks.push(cblock.id);
		}
	}

	// console.info(name,needDelblocks);
	for(let i = 0; i < needDelblocks.length; ++i){
		delBlock(needDelblocks[i] - i);
	}

	//Process all pending closures and lambdas
	var closures = pendingClosures.map(function (cl) {
		return {
			id: cl.id,
			closure: analyzeClosure(
				cl.closure,
				cl.environment,
				cl.parentclosure,
				cl.parentblockid
			),
		};
	});

	vars.sort(function (a, b) {
		if (a.id < b.id) {
			return -1;
		} else if (a.id === b.id) {
			return 0;
		}
		return 1;
	});

	return new Closure(
		name,
		vars,
		clargs,
		closures,
		enter,
		exit,
		raise,
		blocks,
		strictMode,
		node,
		parentclosure ? parentclosure : null,
		parentblockid ? parentblockid : null
	);
}
