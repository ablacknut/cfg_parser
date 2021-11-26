'use strict';

module.exports.parse = createControlFlowGraph;
module.exports.getCFGAndOPS = extractCFG;

var analyzeClosure = require('./lib/analyzer');

function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj))
}
function createControlFlowGraph(root, opts) {
	//Create default environment
	var env = {};

	//Set defaults
	if (opts) {
		for (var id in opts) {
			env[id] = opts[id];
		}
	}

	env.temp = { counter: 0 };

	//Run analysis
	return analyzeClosure(root, env);
}

function deepClone(obj) {
    var type = Object.prototype.toString.call(obj);  //通过原型对象获取对象类型
    var newObj;
    if(type ==='[object Array]'){
        //数组
        newObj =[];
        if(obj.length >0){
            for(var x=0;x<obj.length;x++){
                newObj.push(deepClone(obj[x]));
            }
        }
    }else if(type==='[object Object]'){
        //对象
        newObj = {};
        for(var x in obj) {
            newObj[x] = deepClone(obj[x]);
        }
    }else{
        //基本类型和方法可以直接赋值
        newObj = obj;
    }
    return newObj;
}

function extractCFG(closure, depth = 1) {
	function modifyBlocksNext(params) {
		let blocks = params.blocks;
		let num = params.num;
		let funcnext = params.parentblock
			? params.parentblock.terminator.next > params.parentblock.id
				? params.parentblock.terminator.next + blocks.length - 3
				: params.parentblock.terminator.next
			: 0;
		let parentexception = params.parentblock
			? params.parentblock.exception
			: [];
		let threshold = params.threshold ? params.threshold : 1;
		if (threshold == 1) {
			num = num - 2;
		}
		for (let i = 0; i < blocks.length; ++i) {
			if (threshold > 1 && blocks[i].id > threshold) {
				blocks[i].id = blocks[i].id + num;
			} else if (threshold == 1) {
				blocks[i].id = blocks[i].id + num;
			}
			for (let j = 0; j < blocks[i].exception.length; ++j) {
				if (blocks[i].exception[j] > threshold) {
					blocks[i].exception[j] = blocks[i].exception[j] + num;
				}
			}
			blocks[i].exception = Array.from(
				new Set([...parentexception, ...blocks[i].exception])
			);
			if (blocks[i].terminator.type == 'JumpTerminator') {
				if (blocks[i].terminator.next > threshold) {
					blocks[i].terminator.next = blocks[i].terminator.next + num;
				} else if (blocks[i].terminator.next == 0) {
					blocks[i].terminator.next = funcnext;
				}
			} else if (blocks[i].terminator.type == 'IfTerminator') {
				if (blocks[i].terminator.consequent > threshold) {
					blocks[i].terminator.consequent =
						blocks[i].terminator.consequent + num;
				} else if (blocks[i].terminator.consequent == 0) {
					blocks[i].terminator.consequent = funcnext;
				}
				if (blocks[i].terminator.alternate > threshold) {
					blocks[i].terminator.alternate =
						blocks[i].terminator.alternate + num;
				} else if (blocks[i].terminator.alternate == 0) {
					blocks[i].terminator.alternate = funcnext;
				}
			}
		}
	}

	function modifyBlocks(closure, depth) {
		if (depth == 1) {
			return;
		} else if (depth < 1) {
			console.info('what do you mean???');
			return;
		}
		for (let i = 0; i < closure.closures.length; ++i) {
			modifyBlocks(closure.closures[i].closure, depth - 1);
		}
		let changenum = 0;
		for (let i = 0; i < closure.closures.length; ++i) {
			let cclosure = closure.closures[i].closure;
			let parentblockid = cclosure.parentblockid + changenum;
			// console.info(cclosure.parentblockid);
			modifyBlocksNext({
				blocks: cclosure.blocks,
				num: parentblockid,
				parentblock: closure.blocks[parentblockid],
			});
			modifyBlocksNext({
				blocks: closure.blocks,
				num: cclosure.blocks.length - 3,
				threshold: parentblockid,
			});
			changenum = changenum + cclosure.blocks.length - 3;
			closure.blocks.splice(
				parentblockid,
				1,
				...cclosure.blocks.slice(2)
			);
		}
	}

	function getCFGAndOPS(closure) {
		let blocks = closure.blocks;
		let cfg = [];
		let nodeOps = [];
		for (let i = 0; i < blocks.length; ++i) {
			let index = blocks[i].id;
			nodeOps.push(blocks[i].body);
			if (blocks[i].terminator.type == 'JumpTerminator') {
				cfg.push([index, blocks[i].terminator.next]);
			} else if (blocks[i].terminator.type == 'IfTerminator') {
				cfg.push([index, blocks[i].terminator.consequent]);
				cfg.push([index, blocks[i].terminator.alternate]);
			}
			for (let j = 0; j < blocks[i].exception.length; ++j) {
				cfg.push([index, blocks[i].exception[j]]);
			}
		}
		return [cfg, nodeOps];
	}
	let root = deepClone(closure);
	modifyBlocks(root, depth);
	let [cfg, ops] = getCFGAndOPS(root);
	return [root.blocks, cfg, ops];
}