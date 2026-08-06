import re
import os

html_file = 'data/index.html'
css_file = 'data/style.css'

with open(html_file, 'r', encoding='utf-8') as f:
    html_content = f.read()

style_pattern = re.compile(r'\s*style="([^"]+)"')

css_additions = []
class_counter = 1

def replace_style(match):
    global class_counter
    style_content = match.group(1).strip()
    class_name = f"extracted-style-{class_counter}"
    class_counter += 1
    
    css_additions.append(f".{class_name} {{\n    {style_content.replace(';', ';\n    ')}\n}}")
    return f' class="{class_name}"'

# We need a slightly more complex approach because an element might already have a class attribute.
# Let's find tags, and within them, process style and class attributes.
tag_pattern = re.compile(r'<([a-zA-Z0-9\-]+)([^>]*)>')

def process_tag(match):
    global class_counter
    tag_name = match.group(1)
    attrs = match.group(2)
    
    style_match = re.search(r'style="([^"]+)"', attrs)
    if style_match:
        style_content = style_match.group(1).strip()
        class_name = f"extracted-style-{class_counter}"
        class_counter += 1
        
        # fix formatting for css
        css_rules = [s.strip() for s in style_content.split(';') if s.strip()]
        css_body = ";\n    ".join(css_rules) + ";" if css_rules else ""
        css_additions.append(f".{class_name} {{\n    {css_body}\n}}")
        
        # remove style from attrs
        attrs = attrs[:style_match.start()] + attrs[style_match.end():]
        
        # add to existing class or create new class attr
        class_match = re.search(r'class="([^"]+)"', attrs)
        if class_match:
            existing_classes = class_match.group(1)
            new_classes = f'{existing_classes} {class_name}'
            attrs = attrs[:class_match.start()] + f'class="{new_classes}"' + attrs[class_match.end():]
        else:
            attrs += f' class="{class_name}"'
            
    return f'<{tag_name}{attrs}>'

new_html_content = tag_pattern.sub(process_tag, html_content)

# Additionally replace script tag
new_html_content = new_html_content.replace('<script src="app.js?v=5" defer></script>', '<script type="module" src="app.js?v=6"></script>')

with open(html_file, 'w', encoding='utf-8') as f:
    f.write(new_html_content)

with open(css_file, 'a', encoding='utf-8') as f:
    f.write("\n\n/* Extracted Inline Styles */\n")
    f.write("\n".join(css_additions))

print(f"Extracted {class_counter - 1} inline styles.")
