---
tags:
- image-classification
- timm
- transformers
library_name: timm
license: mit
---

# Image Safety Classifier

__NOTE: Like all models, this one can make mistakes. NSFW content can be subjective and contextual, this model is intended to help identify this content, use at your own risk.__

`OwenElliott/image-safety-classifier-xs` is a lightweight image classification model designed to categorise images as either NSFW, NSFL, or SFW. NSFW images contain pornographic or highly suggestive content, NSFL images contain gore, and SFW images are everything else. The small size of this model and the SwiftFormer architecture make this model suitable for edge deployment or latency critical applications.

The model is trained on a proprietary dataset of ~320,000 images scraped from the web. These images include a diverse range of content including real photos, drawings, Rule 34, screenshots, AI generated images, memes, and more. The NSFW and SFW classes were checked with `Marqo/nsfw-image-detection-384` and any images which were confidently predicted to be in the wrong class were manually reviewed.

## Model Family

This model is part of a lineup of image safety classification models in 4 different sizes. All models are finetunes of SwiftFormer models.

| Model Name                                                                                                                   | Parameters | Accuracy |
|------------------------------------------------------------------------------------------------------------------------------|------------|----------|
| [`OwenElliott/image-safety-classifier-xs`](https://huggingface.co/OwenElliott/image-safety-classifier-xs) (this model)           | 3.5M       | 97.76% |
| [`OwenElliott/image-safety-classifier-s`](https://huggingface.co/OwenElliott/image-safety-classifier-s)              | 6.1M       | 97.99%  |
| [`OwenElliott/image-safety-classifier-m`](https://huggingface.co/OwenElliott/image-safety-classifier-m)              | 12.1M      | 98.06%  |
| [`OwenElliott/image-safety-classifier-l`](https://huggingface.co/OwenElliott/image-safety-classifier-l)              | 28.5M      | 98.20%  |

## Evaluation

This model outperforms existing NSFW detectors on our dataset, here we provide an evaluation against [Marqo/nsfw-image-detection-384](https://huggingface.co/Marqo/nsfw-image-detection-384) and [Falconsai/nsfw_image_detection](https://huggingface.co/Falconsai/nsfw_image_detection).

![Overall evaluation against other models on NSFW, NSFL and SFW](./images/NSFW-NSFL-SFW-overall-Comparison.png)

![Per class evaluation against other models on NSFW, NSFL and SFW](./images/NSFW-NSFL-SFW-overall-per-class-Comparison.png)

*Note that [Marqo/nsfw-image-detection-384](https://huggingface.co/Marqo/nsfw-image-detection-384) and [Falconsai/nsfw_image_detection](https://huggingface.co/Falconsai/nsfw_image_detection) don't have an explicit NSFL class, for this evaluation the NSFW class from these model is treated as a correct classification for an NSFL image.

## Model Usage

### Image Classification with timm

```bash
pip install timm
```

```python
from urllib.request import urlopen
from PIL import Image
import timm
import torch

img = Image.open(urlopen(
    'https://huggingface.co/datasets/huggingface/documentation-images/resolve/main/beignets-task-guide.png'
))

model = timm.create_model("OwenElliott/image-safety-classifier-xs", pretrained=True)
model = model.eval()

data_config = timm.data.resolve_model_data_config(model)
transforms = timm.data.create_transform(**data_config, is_training=False)

with torch.no_grad():
    output = model(transforms(img).unsqueeze(0)).softmax(dim=-1).cpu()

class_names = model.pretrained_cfg["label_names"]
print("Probabilities:", output[0])
print("Class:", class_names[output[0].argmax()])
```

### ONNX Inference

ONNX models are available with preprocessing baked in — normalization and softmax are part of the graph, so you just need to resize your image and pass pixel values in 0-255 range. Both fp32 and fp16 variants are provided.

```bash
pip install onnxruntime pillow numpy
# For GPU: pip install onnxruntime-gpu
```

```python
from urllib.request import urlopen
from PIL import Image
import numpy as np
import onnxruntime as ort

img = Image.open(urlopen(
    'https://huggingface.co/datasets/huggingface/documentation-images/resolve/main/beignets-task-guide.png'
))

# The model accepts 224x224 images
img = img.convert("RGB").resize((224, 224), Image.BILINEAR)

# Convert to [1, 3, 224, 224] float32 in 0-255
pixels = np.array(img, dtype=np.float32).transpose(2, 0, 1)[np.newaxis]

# Run inference (use fp16 variant for GPU acceleration)
# image colour channel normalisation is baked into the ONNX models
from huggingface_hub import hf_hub_download
model_path = hf_hub_download("OwenElliott/image-safety-classifier-xs", "image-safety-classifier-xs.onnx")
sess = ort.InferenceSession(model_path)
probs = sess.run(None, {{"image": pixels}})[0][0]

class_names = ["NSFL", "NSFW", "SFW"]
print("Probabilities:", dict(zip(class_names, probs)))
print("Class:", class_names[np.argmax(probs)])
```


## Notes on the Dataset

The dataset is primarily NSFW and SFW examples, the NSFL class is very underrepresented, collecting NSFL data at scale has been challenging. This is something I would like to improve in a future version, for the moment this model significatly outperforms other models on NSFL classification however there is definitely room for improvement.

## Citations

```
@InProceedings{Shaker_2023_ICCV,
    author    = {Shaker, Abdelrahman and Maaz, Muhammad and Rasheed, Hanoona and Khan, Salman and Yang, Ming-Hsuan and Khan, Fahad Shahbaz},
    title     = {SwiftFormer: Efficient Additive Attention for Transformer-based Real-time Mobile Vision Applications},
    booktitle = {Proceedings of the IEEE/CVF International Conference on Computer Vision (ICCV)},
    year      = {2023},
}
```

```
@misc{rw2019timm,
  author = {Ross Wightman},
  title = {PyTorch Image Models},
  year = {2019},
  publisher = {GitHub},
  journal = {GitHub repository},
  doi = {10.5281/zenodo.4414861},
  howpublished = {\url{https://github.com/huggingface/pytorch-image-models}}
}
```