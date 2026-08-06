import sys
import re

with open('data/app.js', 'r', encoding='utf-8') as f:
    text = f.read()

def count_braces(text):
    stack = []
    lines = text.split('\n')
    for i, line in enumerate(lines):
        for j, char in enumerate(line):
            if char in '{[(':
                stack.append((char, i+1))
            elif char in '}])':
                if not stack:
                    print(f'Unmatched closing {char} on line {i+1}')
                    return
                top, line_num = stack.pop()
                if (top == '{' and char != '}') or (top == '[' and char != ']') or (top == '(' and char != ')'):
                    print(f'Mismatched closing {char} on line {i+1}, expected to close {top} from line {line_num}')
                    return
    if stack:
        print('Unclosed braces remaining:')
        for char, line_num in stack:
            print(f'{char} from line {line_num}')
    else:
        print('Braces perfectly balanced!')

text = re.sub(r'//.*', '', text)
text = re.sub(r'/\*.*?\*/', '', text, flags=re.DOTALL)
text = re.sub(r'\"(.*?)\"', '\"\"', text)
text = re.sub(r'\'(.*?)\'', '\'\'', text)
text = re.sub(r'`(.*?)`', '``', text, flags=re.DOTALL)

count_braces(text)
